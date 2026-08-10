import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { nowJST } from '@/lib/dates'
import { deliveryTargetMonth } from '@/lib/delivery-status'
import { INVOICE_REMINDER_TEMPLATE } from '@/lib/config'
import { getOrCreateInvoiceUploadToken } from '@/lib/invoice-token'
import {
  claimAutoReminderSlot,
  releaseAutoReminderSlot,
  findInvoiceReminderCandidates,
  sendInvoiceReminders,
} from '@/lib/invoice-reminder'
import { recordCronSuccess } from '@/lib/cron-monitor'

// 請求書未提出リマインドの自動送信（毎月10日）。
// 送る中身は手動送信（app/api/invoice-reminder）とまったく同じで、lib/invoice-reminder を共有する。
// 違うのは「誰が起動するか」と「文面を人が編集できないので既定テンプレートを使う」ことだけ。

// 関数のタイムアウト上限（秒）。委託者の人数ぶん Chatwork API を順に叩くため、
// 既定の短いタイムアウトだと途中で切れうる。Vercel の仕様上リテラルで指定する必要がある。
export const maxDuration = 60

export async function GET(req: NextRequest) {
  // CRON_SECRET 未設定時は素通しさせず、必ず拒否する（フェイルクローズ）。
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: 'Server misconfiguration' }, { status: 500 })
  }
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 途中で落ちたときに「今日の枠」を返せるよう、確保したかどうかを try の外で持つ。
  let claimedDate: string | null = null
  try {
    const today = nowJST()
    const year = today.getFullYear()
    const month = today.getMonth() + 1
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    // 同じ日に二度叩かれても催促を重ねない。送信前に「今日の枠」を取り、取れなければ何もしない。
    if (!(await claimAutoReminderSlot(dateKey))) {
      return Response.json({ ok: true, skipped: true, reason: 'already sent today', date: dateKey })
    }
    claimedDate = dateKey

    // 受付URLは cron にはリクエスト元のオリジンが無いため、環境変数のアプリURLから組み立てる
    // （リマインドメールと同じ NEXT_PUBLIC_APP_URL を使う）。
    // URLの無い催促文は「どこに出せばいいのか分からない」ため、未設定なら送らずにエラーにする。
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')
    if (!appUrl) {
      await releaseAutoReminderSlot(dateKey)
      claimedDate = null
      return Response.json(
        { error: 'NEXT_PUBLIC_APP_URL が未設定のため、請求書受付URLを組み立てられません。' },
        { status: 500 }
      )
    }
    if (!process.env.CHATWORK_API_TOKEN) {
      await releaseAutoReminderSlot(dateKey)
      claimedDate = null
      return Response.json(
        { error: 'CHATWORK_API_TOKEN が未設定のため、リマインドを送信できません。' },
        { status: 500 }
      )
    }

    // 催促する請求書は「前月分」。全委託者「◯月分＝前月業務分」ルールのため、
    // 支払月（＝当月）の行に対応する請求書の対象月は前月になる。
    const invoice = deliveryTargetMonth(year, month)
    const candidates = await findInvoiceReminderCandidates(year, month)

    if (candidates.length === 0) {
      await recordCronSuccess('invoice-reminder')
      return Response.json({ ok: true, year, month, sent: 0, noRoom: 0, failed: 0 })
    }

    const url = `${appUrl}/invoice/${await getOrCreateInvoiceUploadToken()}`
    const results = await sendInvoiceReminders(candidates, {
      template: INVOICE_REMINDER_TEMPLATE,
      invoiceMonth: invoice.month,
      url,
    })

    const sent = results.filter((r) => r.status === 'sent')
    const noRoom = results.filter((r) => r.status === 'no_room')
    const failed = results.filter((r) => r.status === 'error')

    // 送れなかった人は運用で拾う必要があるため、名前と理由をログに残す（応答は件数だけ）。
    for (const r of noRoom) console.warn(`[cron/invoice-reminder] skipped ${r.name}: ${r.message}`)
    for (const r of failed) console.error(`[cron/invoice-reminder] failed ${r.name}: ${r.message}`)

    await recordCronSuccess('invoice-reminder')
    return Response.json({
      ok: true,
      year,
      month,
      invoiceYear: invoice.year,
      invoiceMonth: invoice.month,
      sent: sent.length,
      noRoom: noRoom.length,
      failed: failed.length,
    })
  } catch (err) {
    // 送信に到達せず落ちた場合は枠を返し、原因を直したその日のうちに再実行できるようにする。
    if (claimedDate) await releaseAutoReminderSlot(claimedDate)
    return serverError(err)
  }
}
