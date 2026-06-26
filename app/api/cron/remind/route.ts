import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { getResend } from '@/lib/resend'
import { nowJST, getLastDayOfMonth, isInReminderWindow } from '@/lib/dates'

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret')
  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = nowJST()
  const year = today.getFullYear()
  const month = today.getMonth() + 1
  const day = today.getDate()
  const lastDay = getLastDayOfMonth(year, month)

  const remindDay10 = isInReminderWindow(day, 10)
  const remindDay15 = isInReminderWindow(day, 15)
  const remindDay20 = isInReminderWindow(day, 20)
  const remindDay25 = isInReminderWindow(day, 25)
  const remindLastDay = isInReminderWindow(day, lastDay)

  const supabase = createAdminClient()

  const { data: records } = await supabase
    .from('monthly_records')
    .select(`
      invoice_received_at, contractor_paid_at,
      assignments ( contractors ( name ), clients ( name ) )
    `)
    .eq('year', year)
    .eq('month', month)

  const { data: clientRecords } = await supabase
    .from('monthly_client_records')
    .select('invoice_sent_at, payment_confirmed_at, clients ( name )')
    .eq('year', year)
    .eq('month', month)

  const { data: globalTask } = await supabase
    .from('monthly_global_tasks')
    .select('expense_confirmed_at, payment_report_confirmed_at, withholding_confirmed_at')
    .eq('year', year)
    .eq('month', month)
    .maybeSingle()

  const sections: string[] = []

  const globalLines: string[] = []
  if (remindDay10 && !globalTask?.expense_confirmed_at) {
    globalLines.push('  □ 社長経費確認（期日: 10日）')
  }
  if (remindDay20 && !globalTask?.payment_report_confirmed_at) {
    globalLines.push('  □ 支払・報酬 請求書チェック出し（期日: 20日）')
  }
  if (remindLastDay && !globalTask?.withholding_confirmed_at) {
    globalLines.push('  □ 源泉所得税確認（期日: 月末）')
  }
  if (globalLines.length > 0) sections.push('■ グローバルタスク\n' + globalLines.join('\n'))

  if (remindDay15) {
    const unsentClients = (clientRecords ?? []).filter((r) => !r.invoice_sent_at)
    if (unsentClients.length > 0) {
      const lines = unsentClients.map((r) => {
        const client = r.clients as { name: string } | null
        return `  □ ${client?.name ?? '?'}`
      })
      sections.push(`■ クライアント — 請求書送付（期日: 15日）\n${lines.join('\n')}`)
    }
  }

  if (remindDay25) {
    const unconfirmedClients = (clientRecords ?? []).filter((r) => !r.payment_confirmed_at)
    if (unconfirmedClients.length > 0) {
      const lines = unconfirmedClients.map((r) => {
        const client = r.clients as { name: string } | null
        return `  □ ${client?.name ?? '?'}`
      })
      sections.push(`■ クライアント — 入金確認（期日: 25日）\n${lines.join('\n')}`)
    }
  }

  if (remindDay10) {
    const unreceived = (records ?? []).filter((r) => !r.invoice_received_at)
    if (unreceived.length > 0) {
      const lines = unreceived.map((r) => {
        const a = r.assignments as { contractors: { name: string } | null; clients: { name: string } | null } | null
        return `  □ ${a?.contractors?.name ?? '?'}（担当: ${a?.clients?.name ?? '?'}）`
      })
      sections.push(`■ 委託者 — 請求書受領（期日: 10日）\n${lines.join('\n')}`)
    }
  }

  if (remindLastDay) {
    const unpaid = (records ?? []).filter((r) => !r.contractor_paid_at)
    if (unpaid.length > 0) {
      const lines = unpaid.map((r) => {
        const a = r.assignments as { contractors: { name: string } | null; clients: { name: string } | null } | null
        return `  □ ${a?.contractors?.name ?? '?'}（担当: ${a?.clients?.name ?? '?'}）`
      })
      sections.push(`■ 委託者 — 報酬支払（期日: 月末）\n${lines.join('\n')}`)
    }
  }

  if (sections.length === 0) {
    return Response.json({ ok: true, skipped: true, reason: 'no pending tasks in reminder window' })
  }

  const totalCount = sections.reduce((acc, s) => acc + (s.match(/□/g)?.length ?? 0), 0)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const body = [
    `本日 ${year}年${month}月${day}日 時点で、以下のタスクが未対応です。`,
    '',
    sections.join('\n\n'),
    '',
    `確認はこちら: ${appUrl}`,
  ].join('\n')

  const resend = getResend()
  const { error: mailErr } = await resend.emails.send({
    from: 'keiri-v3 <noreply@resend.dev>',
    to: process.env.NOTIFICATION_EMAIL!,
    subject: `[経理確認] ${year}年${month}月 未対応タスク ${totalCount}件`,
    text: body,
  })

  if (mailErr) return Response.json({ error: mailErr.message }, { status: 500 })
  return Response.json({ ok: true, sent: true, totalCount })
}
