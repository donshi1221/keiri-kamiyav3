import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { paymentRequests } from '@/lib/schema'
import { eq } from 'drizzle-orm'

// 保存してある原本（base64）を復元して返す。認証内側なので社内からのみ開ける。
// PDFと画像が混在するため、Content-Type は受付時に控えた file_type をそのまま使う。
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/payment-requests/[id]/file'>) {
  try {
    const { id } = await ctx.params
    const [row] = await db
      .select({
        file_name: paymentRequests.file_name,
        file_data: paymentRequests.file_data,
        file_type: paymentRequests.file_type,
      })
      .from(paymentRequests)
      .where(eq(paymentRequests.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    const bytes = Uint8Array.from(Buffer.from(row.file_data, 'base64'))
    return new Response(bytes, {
      headers: {
        'Content-Type': row.file_type,
        'Content-Length': String(bytes.byteLength),
        // ダウンロードさせずブラウザ内で表示する。ファイル名は日本語を含むため
        // ヘッダに直接書けず、RFC 5987 の filename*（UTF-8のパーセントエンコード）で渡す。
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
        // 差し替え後に古い原本が表示されないよう、キャッシュさせない。
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
