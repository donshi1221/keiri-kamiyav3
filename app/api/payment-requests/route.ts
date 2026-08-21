import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { desc, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { paymentRequests } from '@/lib/schema'
import type { PaymentRequestRow } from '@/lib/ui-types'

// 受け付けた振込依頼の一覧。
// 既定は「経理がまだ振り込み終えていないもの」＝受付済み（pending）＋振込予約済み（reserved）。
// 済んだ分（paid / rejected）まで見たいときは ?status=all を付ける。
// 原本（file_data）は1件で数MBになりうるため列ごと除外し、必要なときだけ
// /api/payment-requests/[id]/file から取り出す。
export async function GET(req: NextRequest) {
  try {
    const all = req.nextUrl.searchParams.get('status') === 'all'

    const rows = await db.query.paymentRequests.findMany({
      columns: { file_data: false },
      where: all ? undefined : inArray(paymentRequests.status, ['pending', 'reserved']),
      orderBy: [desc(paymentRequests.created_at)],
    })

    const data: PaymentRequestRow[] = rows
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}
