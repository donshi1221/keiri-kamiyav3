import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { payrollReimbursementItems } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { parseBody, payrollReimbursementPatchSchema } from '@/lib/validation'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/payroll-reimbursements/[id]'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(payrollReimbursementPatchSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const v = parsed.data

    const patch: Partial<typeof payrollReimbursementItems.$inferInsert> = {}
    if (v.item_date !== undefined) patch.item_date = v.item_date
    if (v.description !== undefined) patch.description = v.description
    if (v.amount !== undefined) patch.amount = v.amount

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    const [updated] = await db
      .update(payrollReimbursementItems)
      .set(patch)
      .where(eq(payrollReimbursementItems.id, id))
      .returning()
    if (!updated) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(updated)
  } catch (err) {
    return serverError(err)
  }
}

// 経費チェックから取り込んだ行も消せるようにする。消すと出どころ（expense_upload_item_id）ごと
// 消えるため、同じ経費を登録し直せば再び取り込める＝取り消しのやり直しが利く。
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/payroll-reimbursements/[id]'>
) {
  try {
    const { id } = await ctx.params
    const [deleted] = await db
      .delete(payrollReimbursementItems)
      .where(eq(payrollReimbursementItems.id, id))
      .returning()
    if (!deleted) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
