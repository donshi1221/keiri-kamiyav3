import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clientBillingItems, monthlyClientRecords } from '@/lib/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { parseBody, billingItemPatchSchema } from '@/lib/validation'
import { nowJST } from '@/lib/dates'

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
    if (v.monthly_video_count !== undefined) patch.monthly_video_count = v.monthly_video_count
    if (v.one_time !== undefined) patch.one_time = v.one_time
    if (v.contract_start !== undefined) patch.contract_start = v.contract_start ?? null
    if (v.contract_months !== undefined) patch.contract_months = v.contract_months
    if (v.active !== undefined) patch.active = v.active
    if (v.sort_order !== undefined) patch.sort_order = v.sort_order

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    // 初回のみ（初期費用）かどうかは、今回の送信内容だけでは判定できない。
    // 例えば one_time を送らずに契約期間だけ更新されると、既存の初期費用が毎月請求に化けてしまう。
    // 未送信の項目は既存行の値を使って判定する。
    const [current] = await db.select().from(clientBillingItems).where(eq(clientBillingItems.id, id))
    if (!current) return Response.json({ error: 'Not found' }, { status: 404 })

    const oneTime = v.one_time ?? current.one_time
    if (oneTime) {
      const contractStart = v.contract_start !== undefined ? (v.contract_start ?? null) : current.contract_start
      // 請求月が無いと毎月請求が立ち続けるため、初期費用としては保存させない。
      if (!contractStart) {
        return Response.json({ error: '初回のみの内訳には請求月が必要です。' }, { status: 400 })
      }
      // 初回のみ＝請求月の1ヶ月だけ有効。動画の本数も持たない。
      patch.contract_months = 1
      patch.monthly_video_count = 0
    }

    const [data] = await db.update(clientBillingItems).set(patch).where(eq(clientBillingItems.id, id)).returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })

    // 月額を変えたときは、生成済みの月次記録の控えも今月以降のぶんだけ追従させる。
    // 過去月と請求書送付済みの月は、確定した数字を遡って変えないため対象外にする。
    if (v.billing_amount !== undefined) {
      const now = nowJST()
      const cutoff = now.getFullYear() * 100 + (now.getMonth() + 1)
      await db
        .update(monthlyClientRecords)
        .set({ billing_amount_snapshot: v.billing_amount })
        .where(
          and(
            eq(monthlyClientRecords.billing_item_id, id),
            isNull(monthlyClientRecords.invoice_sent_at),
            sql`${monthlyClientRecords.year} * 100 + ${monthlyClientRecords.month} >= ${cutoff}`
          )
        )
    }

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
