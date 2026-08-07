import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { invoiceUploads } from '@/lib/schema'
import { extractInvoiceAndSave } from '@/lib/invoice-extract'
import { eq } from 'drizzle-orm'

// 関数のタイムアウト上限（秒）。外部AI（Gemini）にPDFを渡して読み取るため既定では足りない。
export const maxDuration = 60

// 再読み取り。AI側の一時的な失敗（レート制限・タイムアウト）は再実行で直ることが多いので、
// 受付時に失敗した行を画面から叩き直せるようにする。
export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]/extract'>
) {
  try {
    const { id } = await ctx.params
    const [row] = await db
      .select({ file_name: invoiceUploads.file_name, file_data: invoiceUploads.file_data })
      .from(invoiceUploads)
      .where(eq(invoiceUploads.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    const outcome = await extractInvoiceAndSave(id, row.file_data, row.file_name)
    // 読み取れなかった理由は画面に出す必要があるため、失敗も200で内容として返す
    // （HTTPエラーにすると「通信に失敗しました」に丸められ、理由が伝わらない）。
    return Response.json(outcome)
  } catch (err) {
    return serverError(err)
  }
}
