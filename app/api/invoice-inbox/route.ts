import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { invoiceUploads } from '@/lib/schema'
import { verifyInvoiceUploadToken } from '@/lib/invoice-token'
import { UPLOAD_MAX_BYTES } from '@/lib/config'

// 公開エンドポイント（proxy.ts の認証除外）。ログインの代わりに受付トークンで入口を絞る。
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()

    const token = formData.get('token')
    if (typeof token !== 'string' || !(await verifyInvoiceUploadToken(token))) {
      return Response.json({ error: 'このURLは無効です。担当者に新しいURLをご確認ください。' }, { status: 401 })
    }

    const file = formData.get('file')
    if (!(file instanceof File)) {
      return Response.json({ error: 'ファイルが選択されていません' }, { status: 400 })
    }
    if (file.type !== 'application/pdf') {
      return Response.json({ error: 'PDFファイルのみアップロードできます' }, { status: 400 })
    }

    // サイズ上限を超えるファイルは、メモリに読み込む前に弾く（メモリ枯渇の防止）。
    if (file.size > UPLOAD_MAX_BYTES) {
      const maxMb = Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))
      return Response.json({ error: `ファイルサイズが上限（${maxMb}MB）を超えています` }, { status: 413 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    // 返すのはidだけにする。PDF本体（file_data）を公開エンドポイントのレスポンスに載せない。
    const [data] = await db
      .insert(invoiceUploads)
      .values({ file_name: file.name, file_data: buffer.toString('base64') })
      .returning({ id: invoiceUploads.id })
    return Response.json({ id: data.id }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
