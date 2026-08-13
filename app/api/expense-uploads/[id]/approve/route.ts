import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { expenseUploads, expenseUploadItems, clientExpenses } from '@/lib/schema'

// 経理の最終判断（登録）。代表が割り当てた明細のうち、クライアントに請求する分だけを
// client_expenses（自社が直接払い、クライアントへ請求する経費）へ登録する。
export async function POST(_req: NextRequest, ctx: RouteContext<'/api/expense-uploads/[id]/approve'>) {
  try {
    const { id } = await ctx.params

    const [upload] = await db
      .select({ id: expenseUploads.id, status: expenseUploads.status })
      .from(expenseUploads)
      .where(eq(expenseUploads.id, id))
    if (!upload) return Response.json({ error: 'Not found' }, { status: 404 })

    // 登録済みの再実行は同じ経費をもう一度作ってしまう（＝クライアントへの二重請求）ので必ず止める。
    if (upload.status === 'registered') {
      return Response.json({ error: 'この経費ファイルはすでに登録済みです。' }, { status: 409 })
    }

    const items = await db
      .select()
      .from(expenseUploadItems)
      .where(eq(expenseUploadItems.upload_id, id))
      .orderBy(asc(expenseUploadItems.sort_order))

    // client_billed の明細だけを登録する。
    // company（自社経費）と excluded（対象外）を client_expenses に入れないのは、代表が使った経費は
    // マネーフォワード側で既に金額計上されているため。ここでも足すと同じ支出を二重に数えてしまう。
    const billed = items.filter((item) => item.kind === 'client_billed')

    // 1行でも欠けていれば何も登録しない。一部だけ入った状態は「どこまで登録したか」が
    // 画面から分からず、続きを人が手で埋める羽目になるため。
    const invalid = billed.find((item) => !item.item_date || !item.client_id || !item.category)
    if (invalid) {
      const line = invalid.sort_order + 1
      const reason = !invalid.item_date ? '利用日' : !invalid.client_id ? 'クライアント' : '経費科目'
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

      // year / month は「どの月の請求に乗せるか」。利用日そのものから導く（date列は YYYY-MM-DD 固定）。
      const itemDate = item.item_date!
      const year = Number(itemDate.slice(0, 4))
      const month = Number(itemDate.slice(5, 7))

      // client_expenses には科目の列が無いため、科目と区間・内容をまとめて摘要（note）に残す。
      // 後から「何の経費か」を追えるようにするのが目的。
      const route = [item.from_place, item.to_place].filter(Boolean).join('→')
      const note = [item.category, route, item.description].filter(Boolean).join(' ')

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

    return Response.json({ id, status: 'registered', registered })
  } catch (err) {
    return serverError(err)
  }
}
