import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { paymentRequests } from '@/lib/schema'
import { verifyPaymentRequestToken } from '@/lib/payment-token'
import { extractPaymentAndSave } from '@/lib/payment-extract'
import { savePaymentRequestToDrive } from '@/lib/payment-drive'
import { getResend } from '@/lib/resend'
import { UPLOAD_MAX_BYTES, PAYMENT_REQUEST_MIME_PREFIXES } from '@/lib/config'
import type { PaymentInboxResponse } from '@/lib/ui-types'

// 関数のタイムアウト上限（秒）。受付のたびに外部AI（Gemini）へファイルを渡して読み取り、
// さらに原本をGoogleドライブへ転送するため、既定の短いタイムアウトだと途中で打ち切られる。
// Vercel の仕様上リテラルで指定する。
export const maxDuration = 60

function formatAmount(amount: number | null): string {
  return amount === null ? '（読み取れませんでした）' : `${amount.toLocaleString('ja-JP')}円`
}

// 公開エンドポイント（proxy.ts の認証除外）。ログインの代わりに受付トークンで入口を絞る。
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()

    const token = formData.get('token')
    if (typeof token !== 'string' || !(await verifyPaymentRequestToken(token))) {
      return Response.json({ error: 'このURLは無効です。担当者に新しいURLをご確認ください。' }, { status: 401 })
    }

    const file = formData.get('file')
    if (!(file instanceof File)) {
      return Response.json({ error: 'ファイルが選択されていません' }, { status: 400 })
    }
    // 画像はサブタイプが機種でまちまち（jpeg / heic / webp）なので前方一致で判定する。
    if (!PAYMENT_REQUEST_MIME_PREFIXES.some((prefix) => file.type.startsWith(prefix))) {
      return Response.json({ error: 'PDFまたは画像ファイルのみアップロードできます' }, { status: 400 })
    }

    // サイズ上限を超えるファイルは、メモリに読み込む前に弾く（メモリ枯渇の防止）。
    if (file.size > UPLOAD_MAX_BYTES) {
      const maxMb = Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))
      return Response.json({ error: `ファイルサイズが上限（${maxMb}MB）を超えています` }, { status: 413 })
    }

    // メモは任意。空欄で送られることが多いので、空文字は null に寄せる
    //（空文字が残ると画面で「メモあり」と誤って表示されてしまうため）。
    const rawNote = formData.get('note')
    const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : null

    const buffer = Buffer.from(await file.arrayBuffer())
    const fileData = buffer.toString('base64')
    const [row] = await db
      .insert(paymentRequests)
      .values({ file_name: file.name, file_data: fileData, file_type: file.type, note })
      .returning({ id: paymentRequests.id, created_at: paymentRequests.created_at })

    // 保存後にAI読み取りを行うが、失敗しても受付は成功（201）として扱う。
    // 本業は「ファイルを確実に預かること」で、読み取り失敗の理由は extract_error に残り、
    // 経理は原本を見て自分で振込できる（既存の請求書・経費の受付と同じ方針）。
    let dueDate: string | null = null
    let payee: string | null = null
    let amount: number | null = null
    let extractError: string | null = null
    try {
      const outcome = await extractPaymentAndSave(row.id, fileData, file.type, file.name)
      if ('error' in outcome) extractError = outcome.error
      else {
        payee = outcome.payee
        amount = outcome.amount
        dueDate = outcome.due_date
      }
    } catch (err) {
      // 読み取り結果の書き戻しに失敗しても、預かったファイルは既に保存済み。
      console.error('[payment-inbox:extract]', err)
      extractError = 'AIの読み取りに失敗しました。'
    }

    // ドライブ保存は読み取りの成否に関わらずこの時点で行う。原本の保管は経理の判断を待つ理由が無く、
    // 後回しにすると読み取り失敗の分だけ控えが残らない、という抜けが生まれるため。
    // 失敗しても受付は成功（drive_file_id は null のままで、再読み取り時にやり直せる）。
    try {
      const saved = await savePaymentRequestToDrive(row.id, file.name, fileData, file.type, dueDate, row.created_at)
      if ('error' in saved) console.error('[payment-inbox:drive]', saved.error)
    } catch (err) {
      console.error('[payment-inbox:drive]', err)
    }

    // 通知は保険であり本業の受付を止めない。宛先未設定や送信失敗があっても受付自体は成功として返す。
    try {
      if (!process.env.RESEND_API_KEY || !process.env.NOTIFICATION_EMAIL) {
        console.warn('[payment-inbox] RESEND_API_KEY または NOTIFICATION_EMAIL が未設定のため通知メールをスキップしました。')
      } else {
        const resend = getResend()
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
        const { error: mailErr } = await resend.emails.send({
          from: 'keiri-v3 <noreply@resend.dev>',
          to: process.env.NOTIFICATION_EMAIL,
          subject: `[振込依頼] 代表から振込依頼が届きました（${file.name}）`,
          text: [
            '代表から振込依頼が届きました。',
            '',
            `ファイル名: ${file.name}`,
            `振込先: ${payee ?? '（読み取れませんでした）'}`,
            `金額: ${formatAmount(amount)}`,
            `支払期日: ${dueDate ?? '（読み取れませんでした）'}`,
            `メモ: ${note ?? '（なし）'}`,
            ...(extractError ? ['', `読み取りエラー: ${extractError}`] : []),
            '',
            `確認はこちら: ${appUrl}/payment-check`,
          ].join('\n'),
        })
        if (mailErr) console.error('[payment-inbox] mail send failed:', mailErr)
      }
    } catch (mailErr) {
      console.error('[payment-inbox] mail send failed:', mailErr)
    }

    // 読み取り結果は代表には返さない（経理が確認する前提のため、代表の画面では判断させない）。
    const result: PaymentInboxResponse = { id: row.id }
    return Response.json(result, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
