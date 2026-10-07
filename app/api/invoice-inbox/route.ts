import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { contractors, invoiceReplies, invoiceUploads } from '@/lib/schema'
import { verifyInvoiceUploadToken } from '@/lib/invoice-token'
import { extractInvoiceAndSave } from '@/lib/invoice-extract'
import { checkInvoiceAndSave } from '@/lib/invoice-check'
import { buildInvoiceNotificationMail } from '@/lib/invoice-reply'
import { getResend } from '@/lib/resend'
import { INVOICE_NOTIFY_TIMEOUT_MS, UPLOAD_MAX_BYTES } from '@/lib/config'

// 関数のタイムアウト上限（秒）。受付のたびに外部AI（Gemini）へPDFを渡して読み取るため、
// 既定の短いタイムアウトだと読み取り中に打ち切られる。Vercel の仕様上リテラルで指定する。
export const maxDuration = 60

// 届いた請求書の判定結果を経理へメールで知らせる。画面を開かなくても「届いたこと」と
// 「対応が要るか」が分かるようにするための保険で、受付の成否には影響させない（例外は外へ出さない）。
// 送るのは受付時の1回だけ。再チェックのたびに送ると、マスタを直しながら押し直すだけで通知が並んでしまう。
async function notifyAccounting(id: string): Promise<void> {
  try {
    if (!process.env.RESEND_API_KEY || !process.env.NOTIFICATION_EMAIL) {
      console.warn('[invoice-inbox] RESEND_API_KEY または NOTIFICATION_EMAIL が未設定のため通知メールをスキップしました。')
      return
    }
    // 判定はDBに書き戻された内容を読み直して使う。照合が途中で例外になった場合でも、
    // 実際に保存されている状態（未チェック・読み取り失敗）をそのまま伝えられる。
    const [row] = await db
      .select({
        file_name: invoiceUploads.file_name,
        status: invoiceUploads.status,
        contractor_name: contractors.name,
        extracted_issuer: invoiceUploads.extracted_issuer,
        extracted_amount: invoiceUploads.extracted_amount,
        extracted_month: invoiceUploads.extracted_month,
        resolved_month: invoiceUploads.resolved_month,
        check_notes: invoiceUploads.check_notes,
        extract_error: invoiceUploads.extract_error,
        reply_state: invoiceReplies.state,
      })
      .from(invoiceUploads)
      .leftJoin(contractors, eq(invoiceUploads.contractor_id, contractors.id))
      .leftJoin(invoiceReplies, eq(invoiceReplies.upload_id, invoiceUploads.id))
      .where(eq(invoiceUploads.id, id))
    if (!row) return

    const mail = buildInvoiceNotificationMail({
      senderName: row.contractor_name ?? row.extracted_issuer,
      fileName: row.file_name,
      month: row.resolved_month ?? row.extracted_month,
      amount: row.extracted_amount,
      status: row.status,
      checkNotes: row.check_notes,
      extractError: row.extract_error,
      hasReplyDraft: row.reply_state === 'draft',
      checkUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/invoice-check`,
    })

    // このルートは読み取りと照合で60秒枠の大半を使う。メールの応答を待ち続けて関数ごと
    // 打ち切られると受付の応答（201）まで失われるため、上限を決めて諦める。
    const sending = getResend().emails.send({
      from: 'keiri-v3 <noreply@resend.dev>',
      to: process.env.NOTIFICATION_EMAIL,
      subject: mail.subject,
      text: mail.text,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), INVOICE_NOTIFY_TIMEOUT_MS)
    })
    const result = await Promise.race([sending, timeout]).finally(() => clearTimeout(timer))
    if (!result) {
      // 待つのをやめたあとで送信が失敗しても、拾う相手がいない例外にならないようにする。
      sending.catch(() => {})
      console.error('[invoice-inbox] mail send timed out')
      return
    }
    if (result.error) {
      console.error('[invoice-inbox] mail send failed:', result.error)
      return
    }
    await db.update(invoiceUploads).set({ notified_at: new Date().toISOString() }).where(eq(invoiceUploads.id, id))
  } catch (err) {
    console.error('[invoice-inbox] mail send failed:', err)
  }
}

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
      if (!('error' in outcome)) {
        await checkInvoiceAndSave(data.id, { trigger: 'upload', origin: req.nextUrl.origin })
      }
    } catch (err) {
      // 読み取り結果の書き戻しに失敗しても、預かったPDFは既に保存済み。
      console.error('[invoice-inbox:extract]', err)
    }

    await notifyAccounting(data.id)

    return Response.json({ id: data.id }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
