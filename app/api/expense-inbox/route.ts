import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { expenseUploads, expenseUploadItems } from '@/lib/schema'
import { verifyExpenseUploadToken } from '@/lib/expense-token'
import { extractExpenseAndSave } from '@/lib/expense-extract'
import { UPLOAD_MAX_BYTES, EXPENSE_UPLOAD_MIME_PREFIXES } from '@/lib/config'

// 関数のタイムアウト上限（秒）。受付のたびに外部AI（Gemini）へファイルを渡して読み取るため、
// 既定の短いタイムアウトだと読み取り中に打ち切られる。Vercel の仕様上リテラルで指定する。
export const maxDuration = 60

// 公開エンドポイント（proxy.ts の認証除外）。ログインの代わりに受付トークンで入口を絞る。
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()

    const token = formData.get('token')
    if (typeof token !== 'string' || !(await verifyExpenseUploadToken(token))) {
      return Response.json({ error: 'このURLは無効です。担当者に新しいURLをご確認ください。' }, { status: 401 })
    }

    const file = formData.get('file')
    if (!(file instanceof File)) {
      return Response.json({ error: 'ファイルが選択されていません' }, { status: 400 })
    }
    // 画像はサブタイプが機種でまちまち（jpeg / heic / webp）なので前方一致で判定する。
    if (!EXPENSE_UPLOAD_MIME_PREFIXES.some((prefix) => file.type.startsWith(prefix))) {
      return Response.json({ error: 'PDFまたは画像ファイルのみアップロードできます' }, { status: 400 })
    }

    // サイズ上限を超えるファイルは、メモリに読み込む前に弾く（メモリ枯渇の防止）。
    if (file.size > UPLOAD_MAX_BYTES) {
      const maxMb = Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))
      return Response.json({ error: `ファイルサイズが上限（${maxMb}MB）を超えています` }, { status: 413 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const fileData = buffer.toString('base64')
    const [upload] = await db
      .insert(expenseUploads)
      .values({ file_name: file.name, file_data: fileData, file_type: file.type })
      .returning({ id: expenseUploads.id })

    // 保存後にAI読み取りを行うが、失敗しても受付は成功（201）として扱う。
    // 本業は「ファイルを確実に預かること」で、読み取り失敗の理由は extract_error に残り、
    // 明細が空でも代表が手で足せる（既存の invoice-inbox と同じ方針）。
    let extractError: string | null = null
    try {
      const outcome = await extractExpenseAndSave(upload.id, fileData, file.type, file.name)
      if ('error' in outcome) extractError = outcome.error
    } catch (err) {
      // 読み取り結果の書き戻しに失敗しても、預かったファイルは既に保存済み。
      console.error('[expense-inbox:extract]', err)
      extractError = 'AIの読み取りに失敗しました。'
    }

    // 読み取った明細をそのまま返す。代表はこの画面で行ごとにクライアントと科目を割り当てて
    // 送信するため、IDを含む明細が手元に無いと次の操作へ進めない。
    // 原本（file_data）は公開エンドポイントのレスポンスに載せない。
    const items = await db
      .select()
      .from(expenseUploadItems)
      .where(eq(expenseUploadItems.upload_id, upload.id))
      .orderBy(asc(expenseUploadItems.sort_order))

    return Response.json(
      { id: upload.id, file_name: file.name, file_type: file.type, extract_error: extractError, items },
      { status: 201 }
    )
  } catch (err) {
    return serverError(err)
  }
}
