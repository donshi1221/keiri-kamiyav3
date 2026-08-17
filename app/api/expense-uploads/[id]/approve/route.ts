import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { expenseUploads, expenseUploadItems, clientExpenses } from '@/lib/schema'
import { nextMonthOf } from '@/lib/dates'
import { autoCheckExpenseTaskIfCleared } from '@/lib/expense-clear'
import { uploadFileToDrive, sanitizeFileNamePart } from '@/lib/google-drive'
import type { ExpenseUploadItem } from '@/lib/schema'
import type { ExpenseApproveResult } from '@/lib/ui-types'

// 関数のタイムアウト上限（秒）。登録時に数MBの原本をGoogleドライブへ転送するため、
// 既定の短いタイムアウトだと保存中に打ち切られる。ドライブ保存を行う他のAPIと同じ値にする。
export const maxDuration = 60

// 経費ファイルの明細は原本1件で1か月分あり、月をまたぐこともある。保存先は
// 「クライアントへ請求する月」で揃える（経理はドライブを請求に乗る月で整理しているため）。
// 請求に乗る行が無い受付でも原本は残すので、その場合は全明細から、利用日が1件も無ければ受付日時から決める。
function driveTargetMonth(
  items: Pick<ExpenseUploadItem, 'kind' | 'item_date'>[],
  createdAt: string
): { year: number; month: number } {
  const billed = items.filter((item) => item.kind === 'client_billed' && item.item_date)
  const dated = (billed.length > 0 ? billed : items).map((item) => item.item_date).filter((d): d is string => !!d)
  // 1件の原本が複数月にまたがるときは最も早い月へ入れる。請求の起点になる月に原本があるほうが探しやすい。
  const earliest = dated.sort()[0]
  const base = earliest
    ? { year: Number(earliest.slice(0, 4)), month: Number(earliest.slice(5, 7)) }
    : { year: new Date(createdAt).getFullYear(), month: new Date(createdAt).getMonth() + 1 }
  return nextMonthOf(base.year, base.month)
}

// 「2026-08_経費_ICOCA利用履歴.pdf」の形に揃える。保存先は月別サブフォルダだが、
// 名前にも対象年月を残すのは、フォルダの外へ移動されても何月分か分かるようにするため。
function driveFileName(year: number, month: number, originalName: string): string {
  return `${year}-${String(month).padStart(2, '0')}_経費_${sanitizeFileNamePart(originalName)}`
}

// 原本をドライブへ保存し、成功したら控えを書き戻す。
// 原本は1件で数MBになりうるため、実際に保存する時だけ file_data を読み出す。
async function saveExpenseToDrive(id: string, year: number, month: number): Promise<ExpenseApproveResult['drive']> {
  const [file] = await db
    .select({
      file_name: expenseUploads.file_name,
      file_data: expenseUploads.file_data,
      file_type: expenseUploads.file_type,
    })
    .from(expenseUploads)
    .where(eq(expenseUploads.id, id))
  if (!file) return { error: '原本を取得できませんでした' }

  const saved = await uploadFileToDrive(
    driveFileName(year, month, file.file_name),
    file.file_data,
    year,
    month,
    // 端末によっては種類が空で届く。空のまま送るとmultipartの形が壊れるため、汎用の型で埋める。
    file.file_type || 'application/octet-stream'
  )
  if ('fileId' in saved) {
    await db
      .update(expenseUploads)
      .set({ drive_file_id: saved.fileId, drive_link: saved.link })
      .where(eq(expenseUploads.id, id))
    return { link: saved.link, folderName: saved.folderName }
  }
  // 失敗しても drive_file_id は null のまま残す＝画面から保存だけやり直せる。
  return saved
}

// 経理の最終判断（登録）。代表が割り当てた明細のうち、クライアントに請求する分だけを
// client_expenses（自社が直接払い、クライアントへ請求する経費）へ登録し、原本をドライブへ保存する。
export async function POST(_req: NextRequest, ctx: RouteContext<'/api/expense-uploads/[id]/approve'>) {
  try {
    const { id } = await ctx.params

    const [upload] = await db
      .select({
        id: expenseUploads.id,
        status: expenseUploads.status,
        created_at: expenseUploads.created_at,
        drive_file_id: expenseUploads.drive_file_id,
      })
      .from(expenseUploads)
      .where(eq(expenseUploads.id, id))
    if (!upload) return Response.json({ error: 'Not found' }, { status: 404 })

    const items = await db
      .select()
      .from(expenseUploadItems)
      .where(eq(expenseUploadItems.upload_id, id))
      .orderBy(asc(expenseUploadItems.sort_order))

    // 登録は済んでいるがドライブ保存だけ失敗している行は、この再実行を「保存のやり直し」として扱う。
    // 明細の登録処理へは進ませない（登録済みIDのスキップで二重にはならないが、
    // 登録内容には一切触らない操作だと呼び出し側にもコード上も明確にするため手前で分ける）。
    if (upload.status === 'registered' && !upload.drive_file_id) {
      const { year, month } = driveTargetMonth(items, upload.created_at)
      const drive = await saveExpenseToDrive(id, year, month)
      // 保存のやり直しでは登録状態が変わらないため、自動チェックの判定はしない。
      const result: ExpenseApproveResult = { id, status: 'registered', registered: 0, drive, autoChecked: false }
      return Response.json(result)
    }

    // 登録済みの再実行は同じ経費をもう一度作ってしまう（＝クライアントへの二重請求）ので必ず止める。
    if (upload.status === 'registered') {
      return Response.json({ error: 'この経費ファイルはすでに登録済みです。' }, { status: 409 })
    }

    // client_billed の明細だけを登録する。
    // company（自社経費）と excluded（対象外）を client_expenses に入れないのは、代表が使った経費は
    // マネーフォワード側で既に金額計上されているため。ここでも足すと同じ支出を二重に数えてしまう。
    const billed = items.filter((item) => item.kind === 'client_billed')

    // 1行でも欠けていれば何も登録しない。一部だけ入った状態は「どこまで登録したか」が
    // 画面から分からず、続きを人が手で埋める羽目になるため。
    const invalid = billed.find((item) => !item.item_date || !item.client_id)
    if (invalid) {
      const line = invalid.sort_order + 1
      const reason = !invalid.item_date ? '利用日' : 'クライアント'
      return Response.json(
        { error: `${line}行目の${reason}が未入力のため登録できません。` },
        { status: 400 }
      )
    }

    // neon-http はトランザクションを張れないため、途中で失敗しても再実行できる作りにする。
    // 既にIDが控えられている行は前回の実行で登録済みなので飛ばす（＝再実行しても二重にならない）。
    let registered = 0
    for (const item of billed) {
      if (item.registered_client_expense_id) continue

      // year / month は「どの月の請求に乗せるか」。7月に使った交通費は8月の請求に乗る運用なので、
      // 利用日の月そのものではなく翌月にする（委託者への支払いが翌月なのと同じ考え方）。
      // expense_date には利用日をそのまま残す。いつ移動したのかは請求月とは別に追えるようにするため。
      const itemDate = item.item_date!
      const { year, month } = nextMonthOf(Number(itemDate.slice(0, 4)), Number(itemDate.slice(5, 7)))

      // client_expenses には区間・内容の列が無いため、まとめて摘要（note）に残す。
      // 後から「何の経費か」を追えるようにするのが目的。
      const route = [item.from_place, item.to_place].filter(Boolean).join('→')
      const note = [route, item.description].filter(Boolean).join(' ')

      const [inserted] = await db
        .insert(clientExpenses)
        .values({
          client_id: item.client_id!,
          year,
          month,
          expense_date: itemDate,
          amount: item.amount,
          note: note || null,
        })
        .returning({ id: clientExpenses.id })

      // どの経費行を作ったかを明細に控える。二重登録の検出と、後からの追跡に使う。
      await db
        .update(expenseUploadItems)
        .set({ registered_client_expense_id: inserted.id })
        .where(eq(expenseUploadItems.id, item.id))
      registered += 1
    }

    await db
      .update(expenseUploads)
      .set({ status: 'registered', reviewed_at: new Date().toISOString() })
      .where(eq(expenseUploads.id, id))

    // 自動チェックはドライブ保存より先に行う。保存は外部APIで失敗も遅延もありうるのに対し、
    // 「未処理が無くなったか」は今の登録で確定しているため、保存の成否に巻き込ませない。
    // 失敗しても登録は成立させたいので、結果を返すだけにとどめる。
    let autoChecked = false
    try {
      autoChecked = await autoCheckExpenseTaskIfCleared()
    } catch {
      autoChecked = false
    }

    // ドライブ保存は登録が済んでから。ここで失敗しても登録自体は成立させる
    //（原本の控えが取れないことと、請求経費として登録したことは別の話のため）。
    const { year, month } = driveTargetMonth(items, upload.created_at)
    const drive = await saveExpenseToDrive(id, year, month)

    const result: ExpenseApproveResult = { id, status: 'registered', registered, drive, autoChecked }
    return Response.json(result)
  } catch (err) {
    return serverError(err)
  }
}
