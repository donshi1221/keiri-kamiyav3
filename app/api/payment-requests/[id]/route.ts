import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { paymentRequests } from '@/lib/schema'
import { paymentRequestPatchSchema, parseBody } from '@/lib/validation'
import type { PaymentRequestRow, PaymentRequestStatus } from '@/lib/ui-types'

// 状態から時刻列（reserved_at / paid_at / rejected_at）を導く。
// 経理はチェックを付けるだけでなく、押し間違いを外して前の段階へ戻すこともある。
// そのとき時刻が残っていると「振込済みではないのに振込日がある」行ができてしまうため、
// 状態が示す段階より先の時刻は必ず null に戻す＝状態と時刻が常に一致する。
// 逆に、すでに立っている時刻は上書きしない（実際に予約・振込した時刻が押し直しで書き換わらないように）。
function timestampsFor(
  status: PaymentRequestStatus,
  current: { reserved_at: string | null; paid_at: string | null; rejected_at: string | null }
): { reserved_at: string | null; paid_at: string | null; rejected_at: string | null } {
  const now = new Date().toISOString()
  switch (status) {
    case 'pending':
      return { reserved_at: null, paid_at: null, rejected_at: null }
    case 'reserved':
      return { reserved_at: current.reserved_at ?? now, paid_at: null, rejected_at: null }
    case 'paid':
      // 予約を経ずに直接振り込むこともあるため、reserved_at が無いままの振込済みも許す
      //（無い時刻を後から捏造すると、実際には行っていない予約があったことになってしまう）。
      return { reserved_at: current.reserved_at, paid_at: current.paid_at ?? now, rejected_at: null }
    case 'rejected':
      return { reserved_at: current.reserved_at, paid_at: current.paid_at, rejected_at: current.rejected_at ?? now }
  }
}

// 経理の進捗更新（受付済み → 振込予約済み → 振込済み、および却下と、その取り消し）。
// 認証は proxy.ts が担うため、このルートは社内からしか呼ばれない。
export async function PATCH(req: NextRequest, ctx: RouteContext<'/api/payment-requests/[id]'>) {
  try {
    const { id } = await ctx.params
    const body: unknown = await req.json()

    const parsed = parseBody(paymentRequestPatchSchema, body)
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })

    const [current] = await db
      .select({
        reserved_at: paymentRequests.reserved_at,
        paid_at: paymentRequests.paid_at,
        rejected_at: paymentRequests.rejected_at,
      })
      .from(paymentRequests)
      .where(eq(paymentRequests.id, id))
    if (!current) return Response.json({ error: 'Not found' }, { status: 404 })

    const [updated] = await db
      .update(paymentRequests)
      .set({ status: parsed.data.status, ...timestampsFor(parsed.data.status, current) })
      .where(eq(paymentRequests.id, id))
      // 原本（file_data）は数MBになりうるうえ画面では使わないので返さない。
      .returning({
        id: paymentRequests.id,
        file_name: paymentRequests.file_name,
        file_type: paymentRequests.file_type,
        note: paymentRequests.note,
        status: paymentRequests.status,
        extracted_payee: paymentRequests.extracted_payee,
        extracted_amount: paymentRequests.extracted_amount,
        extracted_due_date: paymentRequests.extracted_due_date,
        extract_error: paymentRequests.extract_error,
        extracted_at: paymentRequests.extracted_at,
        reserved_at: paymentRequests.reserved_at,
        paid_at: paymentRequests.paid_at,
        rejected_at: paymentRequests.rejected_at,
        drive_file_id: paymentRequests.drive_file_id,
        drive_link: paymentRequests.drive_link,
        created_at: paymentRequests.created_at,
      })

    const result: PaymentRequestRow = updated
    return Response.json(result)
  } catch (err) {
    return serverError(err)
  }
}
