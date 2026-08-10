import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyRecords } from '@/lib/schema'
import { eq } from 'drizzle-orm'

const ALLOWED = ['invoice_received_at', 'payment_reserved_at', 'contractor_paid_at'] as const
type ToggleField = typeof ALLOWED[number]

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/checklist/records/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()
    const field = body.field as string

    // 金額の直接入力は2種類ある。編集者は納品実績から出す実支払額（actual_payout_amount）、
    // 代行者は契約額の月次控え（payout_amount_snapshot）。どちらも integer 列で入力の作法が同じため、
    // 値の検証はここでまとめて行う。
    if (field === 'actual_payout_amount' || field === 'payout_amount_snapshot') {
      // 空文字は「未入力（null）」扱い。
      // 数値以外・負数は 400 で弾き、小数は円に小数がない前提で四捨五入する
      // （小数のまま integer 列へ渡すと Postgres が拒否して 500 になるため）。
      const raw = body.value
      let value: number | null
      if (raw === '' || raw === null || raw === undefined) {
        value = null
      } else {
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0) {
          return Response.json({ error: '金額には0以上の数値を入力してください' }, { status: 400 })
        }
        value = Math.round(n)
      }

      // 代行者の月次控え。マスタ（assignments.contractor_payout_amount）を変えても既存月の控えは
      // 変わらないため、契約額が途中で変わった月はここで直接直す。
      // null に戻すと控えが外れ、表示・照合ともマスタの契約額を使う状態へ戻る。
      if (field === 'payout_amount_snapshot') {
        const [data] = await db.update(monthlyRecords)
          .set({ payout_amount_snapshot: value })
          .where(eq(monthlyRecords.id, id))
          .returning()
        if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
        return Response.json(data)
      }

      // 納品チェックの「反映」からは videoCount も一緒に送られる（支払対象本数の控え）。
      // 未指定なら本数列は触らない（金額だけの更新で既存の本数を消さないため）。
      const patch: { actual_payout_amount: number | null; delivered_video_count?: number | null } = {
        actual_payout_amount: value,
      }
      if (body.videoCount !== undefined) {
        const vc = body.videoCount
        if (vc === null || vc === '') {
          patch.delivered_video_count = null
        } else {
          const c = Number(vc)
          if (!Number.isInteger(c) || c < 0) {
            return Response.json({ error: '本数には0以上の整数を指定してください' }, { status: 400 })
          }
          patch.delivered_video_count = c
        }
      }
      const [data] = await db.update(monthlyRecords)
        .set(patch)
        .where(eq(monthlyRecords.id, id))
        .returning()
      if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
      return Response.json(data)
    }

    if (!(ALLOWED as readonly string[]).includes(field)) {
      return Response.json({ error: 'Invalid field' }, { status: 400 })
    }
    // 冪等化: クライアントが「したい状態」を checked で明示的に送る。
    // サーバー側で現在値を反転（トグル）すると、リトライや二重送信で結果が逆転するため。
    if (typeof body.checked !== 'boolean') {
      return Response.json({ error: 'checked (boolean) is required' }, { status: 400 })
    }

    const [current] = await db.select().from(monthlyRecords).where(eq(monthlyRecords.id, id))
    if (!current) return Response.json({ error: 'Not found' }, { status: 404 })

    const toggleField = field as ToggleField
    // 既にチェック済みで再度 checked=true が来た場合は、最初のチェック日時を保持する。
    const existing = current[toggleField] as string | null
    const newValue = body.checked ? (existing ?? new Date().toISOString()) : null

    const [data] = await db.update(monthlyRecords)
      .set({ [toggleField]: newValue })
      .where(eq(monthlyRecords.id, id))
      .returning()

    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}
