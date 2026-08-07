import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { invoiceUploads } from '@/lib/schema'
import { eq } from 'drizzle-orm'

// 受け付けた請求書の削除（テストデータの片付け用）。
// returning() でPDF本体まで返さないよう、idだけを取り出して存在確認に使う。
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]'>
) {
  try {
    const { id } = await ctx.params
    const [deleted] = await db
      .delete(invoiceUploads)
      .where(eq(invoiceUploads.id, id))
      .returning({ id: invoiceUploads.id })
    if (!deleted) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
