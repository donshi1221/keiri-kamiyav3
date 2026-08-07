import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { invoiceUploads } from '@/lib/schema'
import { eq } from 'drizzle-orm'

// 保存してあるPDF（base64）を復元して返す。認証内側なので社内からのみ開ける。
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]/pdf'>
) {
  try {
    const { id } = await ctx.params
    const [row] = await db
      .select({ file_name: invoiceUploads.file_name, file_data: invoiceUploads.file_data })
      .from(invoiceUploads)
      .where(eq(invoiceUploads.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    const bytes = Uint8Array.from(Buffer.from(row.file_data, 'base64'))
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.byteLength),
        // ダウンロードさせずブラウザ内で表示する。ファイル名は日本語を含むため
        // ヘッダに直接書けず、RFC 5987 の filename*（UTF-8のパーセントエンコード）で渡す。
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
        // 削除・再アップロード後に古いPDFが表示されないよう、キャッシュさせない。
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
