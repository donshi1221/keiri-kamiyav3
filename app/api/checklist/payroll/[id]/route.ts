import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyPayrollRecords } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { parseBody, payrollSnapshotPatchSchema } from '@/lib/validation'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/checklist/payroll/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()

    // 振込済みチェックの切り替え。
    // 冪等化: クライアントが「したい状態」を checked で明示的に送る。
    // サーバー側で現在値を反転（トグル）すると、リトライや二重送信で結果が逆転するため。
    if (body.checked !== undefined) {
      if (typeof body.checked !== 'boolean') {
        return Response.json({ error: 'checked (boolean) is required' }, { status: 400 })
      }
      const [current] = await db.select().from(monthlyPayrollRecords).where(eq(monthlyPayrollRecords.id, id))
      if (!current) return Response.json({ error: 'Not found' }, { status: 404 })
      // 既にチェック済みで再度 checked=true が来た場合は、最初のチェック日時を保持する。
      const newValue = body.checked ? (current.paid_at ?? new Date().toISOString()) : null
      const [data] = await db.update(monthlyPayrollRecords)
        .set({ paid_at: newValue })
        .where(eq(monthlyPayrollRecords.id, id))
        .returning()
      return Response.json(data)
    }

    // この月の金額修正（料率改定の月に、その月の控えだけを直す）。
    // マスタを直すと過去月まで遡って金額が変わってしまうため、控えを直接書き換える口をここに持つ。
    const parsed = parseBody(payrollSnapshotPatchSchema, body)
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const v = parsed.data

    const patch: Partial<typeof monthlyPayrollRecords.$inferInsert> = {}
    if (v.gross_snapshot !== undefined) patch.gross_snapshot = v.gross_snapshot
    if (v.health_insurance_snapshot !== undefined) patch.health_insurance_snapshot = v.health_insurance_snapshot
    if (v.pension_snapshot !== undefined) patch.pension_snapshot = v.pension_snapshot
    if (v.employment_insurance_snapshot !== undefined) patch.employment_insurance_snapshot = v.employment_insurance_snapshot
    if (v.income_tax_snapshot !== undefined) patch.income_tax_snapshot = v.income_tax_snapshot
    if (v.resident_tax_snapshot !== undefined) patch.resident_tax_snapshot = v.resident_tax_snapshot
    if (v.expense_reimbursement !== undefined) patch.expense_reimbursement = v.expense_reimbursement

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    const [data] = await db.update(monthlyPayrollRecords)
      .set(patch)
      .where(eq(monthlyPayrollRecords.id, id))
      .returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}
