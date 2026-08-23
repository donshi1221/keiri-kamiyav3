import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { payrollRecurringReimbursements } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { parseBody, recurringReimbursementPatchSchema } from '@/lib/validation'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/recurring-reimbursements/[id]'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(recurringReimbursementPatchSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const v = parsed.data

    // リクエストに含まれた項目だけを更新対象にする（undefined のキーは触らない）。
    // これをしないと、UIが一部の項目だけ送った場合に未送信の項目が 0 や null で上書きされて消える。
    const patch: Partial<typeof payrollRecurringReimbursements.$inferInsert> = {}
    if (v.description !== undefined) patch.description = v.description
    if (v.amount !== undefined) patch.amount = v.amount
    if (v.start_year !== undefined) patch.start_year = v.start_year
    if (v.start_month !== undefined) patch.start_month = v.start_month
    if (v.active !== undefined) patch.active = v.active

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    const [data] = await db
      .update(payrollRecurringReimbursements)
      .set(patch)
      .where(eq(payrollRecurringReimbursements.id, id))
      .returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })

    // 停止から再開した直後も当月の明細が並ぶようにする（対象者マスタの編集と同じ作法）。
    // 金額や項目名を直しただけの場合、生成済みの当月分は一意制約で弾かれて書き換わらない。
    // これは意図どおりで、マスタを直しただけで確定済みの振込額が動く方が事故になるため
    //（その月だけ直したいときは、ダッシュボードの立替明細から明細そのものを直す）。
    const today = nowJST()
    await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)

    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

// 定額設定そのものだけを消し、すでに生成済みの明細（payroll_reimbursement_items）は消さない。
// 過去月の振込額は「その月にいくら振り込んだか」の記録でもあるので、あとからマスタを消したことで
// 遡って金額が変わってしまうと、通帳と帳簿が合わなくなるため。
// 明細側に残る recurring_id は行き先を失うが、外部キー参照を張っていないので不整合にはならない
//（出どころの控えとして残るだけで、生成の判断には使わない）。
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/recurring-reimbursements/[id]'>
) {
  try {
    const { id } = await ctx.params
    const [deleted] = await db
      .delete(payrollRecurringReimbursements)
      .where(eq(payrollRecurringReimbursements.id, id))
      .returning()
    if (!deleted) return Response.json({ error: 'Not found' }, { status: 404 })
    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err)
  }
}
