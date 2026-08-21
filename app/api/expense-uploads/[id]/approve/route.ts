import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  expenseUploads,
  expenseUploadItems,
  clientExpenses,
  payrollRecipients,
  payrollReimbursementItems,
} from '@/lib/schema'
import { addMonthsOf, nextMonthOf } from '@/lib/dates'
import { expenseApproveSchema, parseBody } from '@/lib/validation'
import { autoCheckExpenseTaskIfCleared } from '@/lib/expense-clear'
import { uploadFileToDrive, sanitizeFileNamePart } from '@/lib/google-drive'
import type { ExpenseUploadItem } from '@/lib/schema'
import type { ExpenseApproveResult } from '@/lib/ui-types'

// 関数のタイムアウト上限（秒）。登録時に数MBの原本をGoogleドライブへ転送するため、
// 既定の短いタイムアウトだと保存中に打ち切られる。ドライブ保存を行う他のAPIと同じ値にする。
export const maxDuration = 60

// 経費ファイルの明細は原本1件で1か月分あり、月をまたぐこともある。保存先は
// 「決済（利用）した月」で揃える。請求月は明細ごとに経理が選べるようになり、1件の原本の中で
// 複数の請求月に分かれうるため、請求月を保存先にすると原本の置き場所が決まらない。
// 決済した月なら原本そのものの事実なので必ず1つに定まり、「いつ払ったか」から原本を探せる。
// 請求に乗る行が無い受付でも原本は残すので、その場合は全明細から、利用日が1件も無ければ受付日時から決める。
function driveTargetMonth(
  items: Pick<ExpenseUploadItem, 'kind' | 'item_date'>[],
  createdAt: string
): { year: number; month: number } {
  const billed = items.filter((item) => item.kind === 'client_billed' && item.item_date)
  const dated = (billed.length > 0 ? billed : items).map((item) => item.item_date).filter((d): d is string => !!d)
  // 1件の原本が複数月にまたがるときは最も早い月へ入れる。決済の起点になる月に原本があるほうが探しやすい。
  const earliest = dated.sort()[0]
  return earliest
    ? { year: Number(earliest.slice(0, 4)), month: Number(earliest.slice(5, 7)) }
    : { year: new Date(createdAt).getFullYear(), month: new Date(createdAt).getMonth() + 1 }
}

// 経理が明細ごとに選べる請求月は「利用月・翌月・翌々月」の3択。
// 画面のプルダウンと同じ範囲をサーバー側でも持ち、改ざんされたリクエストで
// 何年も先の月に請求経費が入る事故を防ぐ。
const BILLING_MONTH_OFFSETS = [0, 1, 2]

function isAllowedBillingMonth(itemDate: string, year: number, month: number): boolean {
  const baseYear = Number(itemDate.slice(0, 4))
  const baseMonth = Number(itemDate.slice(5, 7))
  return BILLING_MONTH_OFFSETS.some((offset) => {
    const allowed = addMonthsOf(baseYear, baseMonth, offset)
    return allowed.year === year && allowed.month === month
  })
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

// 経費の明細を人が読める1行の文にする。client_expenses の摘要と立替精算の項目名は
// どちらも「何の経費か」を後から追うためのものなので、同じ作り方を使い回す。
function itemLabel(item: Pick<ExpenseUploadItem, 'from_place' | 'to_place' | 'description'>): string {
  const route = [item.from_place, item.to_place].filter(Boolean).join('→')
  return [route, item.description].filter(Boolean).join(' ')
}

// 代表が立て替えた分を、役員報酬に上乗せする実費返金として積む。
// 乗せる月は利用月の翌月に固定する（クライアントへの請求月は経理が選べるが、本人への返金は
// 「使った翌月の給与で返す」運用で固定されており、相手も目的も別物のため連動させない）。
// 利用日が無い明細は基準の月が決まらないので、原本の保存先と同じ「決済した月」を基準にする。
async function createReimbursements(
  items: ExpenseUploadItem[],
  targetIds: Set<string>,
  fallbackMonth: { year: number; month: number }
): Promise<ExpenseApproveResult['reimbursement']> {
  const targets = items.filter((item) => targetIds.has(item.id) && item.kind !== 'excluded')
  if (targets.length === 0) return { created: 0 }

  // 誰に返すかは役員（＝代表）1人に定まることが前提。0人・2人以上は経理が決めるべき話で、
  // システムが当てずっぽうで選ぶと本人以外へ振り込む事故になるため作らずに理由を返す。
  const executives = await db
    .select({ id: payrollRecipients.id })
    .from(payrollRecipients)
    .where(and(eq(payrollRecipients.active, true), eq(payrollRecipients.kind, 'executive')))
  if (executives.length !== 1) {
    return {
      skipped:
        executives.length === 0
          ? '立替精算の対象となる役員がマスタに登録されていないため、立替明細は作成していません。'
          : '立替精算の対象となる役員が複数登録されているため、対象を1人に決められず立替明細は作成していません。',
    }
  }
  const recipientId = executives[0].id

  let created = 0
  for (const item of targets) {
    const base = item.item_date
      ? { year: Number(item.item_date.slice(0, 4)), month: Number(item.item_date.slice(5, 7)) }
      : fallbackMonth
    const { year, month } = nextMonthOf(base.year, base.month)

    // 出どころ（expense_upload_item_id）の一意制約で二重取り込みを止める。同じ受付を登録し直しても
    // 既にある行はここで無視され、本人への二重払いにはならない。
    const inserted = await db
      .insert(payrollReimbursementItems)
      .values({
        recipient_id: recipientId,
        year,
        month,
        item_date: item.item_date,
        description: itemLabel(item) || '立替経費',
        amount: item.amount,
        expense_upload_item_id: item.id,
      })
      .onConflictDoNothing({ target: payrollReimbursementItems.expense_upload_item_id })
      .returning({ id: payrollReimbursementItems.id })
    created += inserted.length
  }
  return { created }
}

// 経理の最終判断（登録）。代表が割り当てた明細のうち、クライアントに請求する分だけを
// client_expenses（自社が直接払い、クライアントへ請求する経費）へ登録し、原本をドライブへ保存する。
export async function POST(req: NextRequest, ctx: RouteContext<'/api/expense-uploads/[id]/approve'>) {
  try {
    const { id } = await ctx.params

    // ボディは任意。ドライブ保存の再試行は body 無しで呼ばれるため、JSONとして読めなくても
    // エラーにはせず「指定なし＝従来どおり翌月」として扱う。
    const rawBody = await req.json().catch(() => undefined)
    const parsed = parseBody(expenseApproveSchema, rawBody ?? {})
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const requestedMonths = new Map(parsed.data.items?.map((item) => [item.id, item]) ?? [])
    const reimburseItemIds = new Set(parsed.data.reimburseItemIds ?? [])

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
      // 保存のやり直しでは登録状態が変わらないため、自動チェック・立替精算の判定はしない。
      const result: ExpenseApproveResult = {
        id,
        status: 'registered',
        registered: 0,
        drive,
        autoChecked: false,
        reimbursement: { created: 0 },
      }
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

    // 請求月の指定は登録の前にまとめて検証する。1行でも不正なら何も登録しない
    // （一部だけ入ると「どこまで登録したか」が画面から分からなくなるのは未入力チェックと同じ理由）。
    for (const [itemId, requested] of requestedMonths) {
      const target = billed.find((item) => item.id === itemId)
      if (!target) {
        return Response.json(
          { error: '請求月を指定できるのは「クライアントに請求」の明細だけです。画面を再読み込みしてやり直してください。' },
          { status: 400 }
        )
      }
      if (!isAllowedBillingMonth(target.item_date!, requested.year, requested.month)) {
        const line = target.sort_order + 1
        return Response.json(
          { error: `${line}行目の請求月は、利用月から翌々月までの範囲で指定してください。` },
          { status: 400 }
        )
      }
    }

    // neon-http はトランザクションを張れないため、途中で失敗しても再実行できる作りにする。
    // 既にIDが控えられている行は前回の実行で登録済みなので飛ばす（＝再実行しても二重にならない）。
    let registered = 0
    for (const item of billed) {
      if (item.registered_client_expense_id) continue

      // year / month は「どの月の請求に乗せるか」。7月に使った交通費は8月の請求に乗るのが基本なので
      // 既定は利用月の翌月だが、締めの都合でずれる月もあるため経理が画面で選んだ月を優先する。
      // expense_date には利用日をそのまま残す。いつ移動したのかは請求月とは別に追えるようにするため。
      const itemDate = item.item_date!
      const requested = requestedMonths.get(item.id)
      const { year, month } =
        requested ?? nextMonthOf(Number(itemDate.slice(0, 4)), Number(itemDate.slice(5, 7)))

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

    // 立替精算はクライアントへの請求登録とは独立に決まる（自社経費でも代表が立て替えていれば返金は要る）。
    // 原本の保存先と同じ「決済した月」を、利用日が無い明細の基準として渡す。
    const reimbursement = await createReimbursements(items, reimburseItemIds, driveTargetMonth(items, upload.created_at))

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

    const result: ExpenseApproveResult = { id, status: 'registered', registered, drive, autoChecked, reimbursement }
    return Response.json(result)
  } catch (err) {
    return serverError(err)
  }
}
