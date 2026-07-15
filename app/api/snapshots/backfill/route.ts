import { NextRequest } from 'next/server'
import { serverError } from '@/lib/api-error'
import { db } from '@/lib/db'
import { monthlyRecords, monthlyClientRecords, assignments, clientBillingItems } from '@/lib/schema'
import { and, eq } from 'drizzle-orm'
import { parseBody, snapshotBackfillSchema } from '@/lib/validation'

export const maxDuration = 60

// 過去月の金額スナップショット（payout_amount_snapshot / billing_amount_snapshot）を
// 現在のマスタ値から補完・訂正する。
//   fill-missing: 未設定(null)の行だけ埋める（生成漏れの穴埋め）
//   overwrite   : その月の全行を現マスタ値で上書きする（誤りの訂正。過去表示が変わる点に注意）
// proxy.ts で認証必須。
export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(snapshotBackfillSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const { year, month, mode } = parsed.data

    // 委託者側: payout_amount_snapshot ← assignments.contractor_payout_amount
    const recs = await db.select({
      id: monthlyRecords.id,
      snapshot: monthlyRecords.payout_amount_snapshot,
      payout: assignments.contractor_payout_amount,
    })
      .from(monthlyRecords)
      .innerJoin(assignments, eq(monthlyRecords.assignment_id, assignments.id))
      .where(and(eq(monthlyRecords.year, year), eq(monthlyRecords.month, month)))

    let recordsUpdated = 0
    for (const r of recs) {
      if (mode === 'fill-missing' && r.snapshot !== null) continue
      if (r.snapshot === r.payout) continue
      await db.update(monthlyRecords).set({ payout_amount_snapshot: r.payout }).where(eq(monthlyRecords.id, r.id))
      recordsUpdated++
    }

    // クライアント側: billing_amount_snapshot / label_snapshot ← client_billing_items（内訳）
    const clientRecs = await db.select({
      id: monthlyClientRecords.id,
      snapshot: monthlyClientRecords.billing_amount_snapshot,
      labelSnapshot: monthlyClientRecords.label_snapshot,
      billing: clientBillingItems.billing_amount,
      label: clientBillingItems.label,
    })
      .from(monthlyClientRecords)
      .innerJoin(clientBillingItems, eq(monthlyClientRecords.billing_item_id, clientBillingItems.id))
      .where(and(eq(monthlyClientRecords.year, year), eq(monthlyClientRecords.month, month)))

    let clientRecordsUpdated = 0
    for (const r of clientRecs) {
      const amountNeedsFill = !(mode === 'fill-missing' && r.snapshot !== null) && r.snapshot !== r.billing
      const labelNeedsFill = !(mode === 'fill-missing' && r.labelSnapshot !== null) && r.labelSnapshot !== r.label
      if (!amountNeedsFill && !labelNeedsFill) continue
      const set: Partial<typeof monthlyClientRecords.$inferInsert> = {}
      if (amountNeedsFill) set.billing_amount_snapshot = r.billing
      if (labelNeedsFill) set.label_snapshot = r.label
      await db.update(monthlyClientRecords).set(set).where(eq(monthlyClientRecords.id, r.id))
      clientRecordsUpdated++
    }

    return Response.json({ ok: true, year, month, mode, recordsUpdated, clientRecordsUpdated })
  } catch (err) {
    return serverError(err, 'snapshots/backfill')
  }
}
