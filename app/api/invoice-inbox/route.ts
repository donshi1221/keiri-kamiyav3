import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { invoiceUploads } from '@/lib/schema'
import { verifyInvoiceUploadToken } from '@/lib/invoice-token'
import { extractInvoiceAndSave } from '@/lib/invoice-extract'
import { checkInvoiceAndSave } from '@/lib/invoice-check'
import { UPLOAD_MAX_BYTES } from '@/lib/config'

// 関数のタイムアウト上限（秒）。受付のたびに外部AI（Gemini）へPDFを渡して読み取るため、
// 既定の短いタイムアウトだと読み取り中に打ち切られる。Vercel の仕様上リテラルで指定する。
export const maxDuration = 60

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
    const fileData = buffer.toString('base64')
    // 返すのはidだけにする。PDF本体（file_data）を公開エンドポイントのレスポンスに載せない。
    const [data] = await db
      .insert(invoiceUploads)
      .values({ file_name: file.name, file_data: fileData })
      .returning({ id: invoiceUploads.id })

    // 保存後にAI読み取りを行うが、失敗しても受付は成功（201）として扱う。
    // 本業は「請求書を確実に預かること」で、読み取りは社内側の画面から再実行できる。
    // ここで失敗を送信者に返すと、送った本人が原因も対処もできないまま再送を繰り返すことになる。
    // 照合も同じ理由で受付の成否には影響させない（読み取り成功時のみ実行）。
    try {
      const outcome = await extractInvoiceAndSave(data.id, fileData, file.name)
      if (!('error' in outcome)) await checkInvoiceAndSave(data.id)
    } catch (err) {
      // 読み取り結果の書き戻しに失敗しても、預かったPDFは既に保存済み。
      console.error('[invoice-inbox:extract]', err)
    }

    return Response.json({ id: data.id }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
