import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clientBillingItems, monthlyClientRecords } from '@/lib/schema'
import { eq, sql } from 'drizzle-orm'
import { parseBody, billingItemPatchSchema } from '@/lib/validation'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/billing-items/[id]'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(billingItemPatchSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const v = parsed.data

    // 送られてきた項目だけを更新対象にする（未送信の項目を null / 0 で上書きしない）。
    const patch: Partial<typeof clientBillingItems.$inferInsert> = {}
    if (v.label !== undefined) patch.label = v.label?.trim() ?? ''
    if (v.billing_amount !== undefined) patch.billing_amount = v.billing_amount
    if (v.contract_start !== undefined) patch.contract_start = v.contract_start ?? null
    if (v.contract_months !== undefined) patch.contract_months = v.contract_months
    if (v.active !== undefined) patch.active = v.active
    if (v.sort_order !== undefined) patch.sort_order = v.sort_order

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    const [data] = await db.update(clientBillingItems).set(patch).where(eq(clientBillingItems.id, id)).returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/billing-items/[id]'>
) {
  try {
    const { id } = await ctx.params

    // 月次記録が内訳を参照しているとDBの外部キー制約で生の500になる。事前に件数で弾く。
    // 過去の記録を残したい場合は、削除ではなく「非アクティブ化」で今後の生成だけ止める運用にする。
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(monthlyClientRecords)
      .where(eq(monthlyClientRecords.billing_item_id, id))

    if (Number(count) > 0) {
      return Response.json(
        { error: `${count}件の月次記録が存在するため削除できません。`, hint: 'inactive' },
        { status: 409 }
      )
    }

    await db.delete(clientBillingItems).where(eq(clientBillingItems.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err)
  }
}
