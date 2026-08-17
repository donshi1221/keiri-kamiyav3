import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { payrollRecipients, monthlyPayrollRecords } from '@/lib/schema'
import { eq, sql } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { parseBody, payrollRecipientPatchSchema } from '@/lib/validation'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/payroll-recipients/[id]'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(payrollRecipientPatchSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const v = parsed.data

    // リクエストに含まれた項目だけを更新対象にする（undefined のキーは触らない）。
    // これをしないと、UIが一部の項目だけ送った場合に未送信の項目が 0 や null で上書きされて消える。
    const patch: Partial<typeof payrollRecipients.$inferInsert> = {}
    if (v.name !== undefined) patch.name = v.name
    if (v.kind !== undefined) patch.kind = v.kind
    if (v.gross_amount !== undefined) patch.gross_amount = v.gross_amount
    if (v.health_insurance !== undefined) patch.health_insurance = v.health_insurance
    if (v.pension !== undefined) patch.pension = v.pension
    if (v.employment_insurance !== undefined) patch.employment_insurance = v.employment_insurance
    if (v.income_tax !== undefined) patch.income_tax = v.income_tax
    if (v.resident_tax !== undefined) patch.resident_tax = v.resident_tax
    if (v.pay_day !== undefined) patch.pay_day = v.pay_day ?? null
    if (v.active !== undefined) patch.active = v.active

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    const [data] = await db.update(payrollRecipients).set(patch).where(eq(payrollRecipients.id, id)).returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })

    // 非アクティブから戻した直後も当月の支給レコードが並ぶようにする（アサインの編集と同じ作法）。
    // 生成は冪等（onConflictDoNothing）なので、既にある月の控えは書き換わらない。
    const today = nowJST()
    await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)

    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/payroll-recipients/[id]'>
) {
  try {
    const { id } = await ctx.params

    // 月次レコードから参照されている対象者は消せない（過去月の支給記録が壊れるため）。
    // 代わりに非アクティブ化を案内する＝アサイン削除と同じ流儀で hint を返す。
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(monthlyPayrollRecords)
      .where(eq(monthlyPayrollRecords.recipient_id, id))

    if (Number(count) > 0) {
      return Response.json(
        { error: `${count}件の月次記録が存在します。`, hint: 'inactive' },
        { status: 409 }
      )
    }

    await db.delete(payrollRecipients).where(eq(payrollRecipients.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err)
  }
}
