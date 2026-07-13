import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyRecords, monthlyClientRecords, monthlyGlobalTasks, monthlyCustomGlobalTasks } from '@/lib/schema'
import { and, eq } from 'drizzle-orm'
import { getResend } from '@/lib/resend'
import { nowJST, getLastDayOfMonth, isInReminderWindow } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { computeCarryOver } from '@/lib/carry-over'
import { recordCronSuccess, checkCronStale } from '@/lib/cron-monitor'
import { CRON_STALE_ALERT_DAYS } from '@/lib/config'

// 関数のタイムアウト上限（秒）。委託者・クライアントを全件走査しメール送信まで行うため、
// 既定の短いタイムアウトだと途中で切れうる。Vercel の仕様上リテラルで指定する必要がある。
export const maxDuration = 60

function overdueMark(day: number, dueDay: number): string {
  return day > dueDay ? '（期限超過）' : ''
}

export async function GET(req: NextRequest) {
  // CRON_SECRET 未設定時は素通しさせず、必ず拒否する（フェイルクローズ）。
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: 'Server misconfiguration' }, { status: 500 })
  }
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const today = nowJST()
    const year = today.getFullYear()
    const month = today.getMonth() + 1
    const day = today.getDate()
    const lastDay = getLastDayOfMonth(year, month)

    // セーフティネット: 月次生成cron（毎月1日）が失敗するとその月のタスクが丸ごと消える。
    // 生成処理は冪等（onConflictDoNothing）なので、毎朝ここで当月分を生成し直しても既存は壊れない。
    // ただし生成が失敗しても、それ自体は「追加の保険」なので、リマインドメール送信まで
    // 巻き添えで止めない（既存レコードのリマインドは送れるべき）。失敗はログのみ。
    try {
      await generateMonthlyRecords(year, month)
    } catch (genErr) {
      console.error('[remind] generateMonthlyRecords safety-net failed:', genErr)
    }

    const remindDay10 = isInReminderWindow(day, 10)
    const remindDay15 = isInReminderWindow(day, 15)
    const remindDay20 = isInReminderWindow(day, 20)
    const remindDay25 = isInReminderWindow(day, 25)
    const remindLastDay = isInReminderWindow(day, lastDay)

    const [records, clientRecords, globalTask, customTasks] = await Promise.all([
      db.query.monthlyRecords.findMany({
        where: and(eq(monthlyRecords.year, year), eq(monthlyRecords.month, month)),
        columns: { invoice_received_at: true, payment_reserved_at: true, contractor_paid_at: true },
        with: {
          assignments: {
            columns: {},
            with: {
              contractors: { columns: { name: true } },
              clients: { columns: { name: true } },
            },
          },
        },
      }),
      db.query.monthlyClientRecords.findMany({
        where: and(eq(monthlyClientRecords.year, year), eq(monthlyClientRecords.month, month)),
        columns: { invoice_sent_at: true, payment_confirmed_at: true },
        with: { clients: { columns: { name: true } } },
      }),
      db.query.monthlyGlobalTasks.findFirst({
        where: and(eq(monthlyGlobalTasks.year, year), eq(monthlyGlobalTasks.month, month)),
      }),
      db.select().from(monthlyCustomGlobalTasks),
    ])

    // 監視アラート: 月次生成cronがしばらく成功していなければ、メール冒頭で知らせる。
    const alertMsg = await checkCronStale('generate-monthly', CRON_STALE_ALERT_DAYS, today)

    // 繰越督促: 過去月の未完了を集計してメールにも載せる（ダッシュボードの繰越バナーと同じ集計）。
    const [pastRecords, pastClientRecords] = await Promise.all([
      db.select({
        year: monthlyRecords.year,
        month: monthlyRecords.month,
        invoice_received_at: monthlyRecords.invoice_received_at,
        payment_reserved_at: monthlyRecords.payment_reserved_at,
        contractor_paid_at: monthlyRecords.contractor_paid_at,
      }).from(monthlyRecords),
      db.select({
        year: monthlyClientRecords.year,
        month: monthlyClientRecords.month,
        invoice_sent_at: monthlyClientRecords.invoice_sent_at,
        payment_confirmed_at: monthlyClientRecords.payment_confirmed_at,
      }).from(monthlyClientRecords),
    ])
    const carryGroups = computeCarryOver(pastRecords, pastClientRecords, year, month)

    const sections: string[] = []

    if (carryGroups.length > 0) {
      const carryLines = carryGroups.map(
        (g) => `  □ ${g.year}年${g.month}月: ${g.items.map((i) => `${i.label} ${i.count}件`).join('、')}`
      )
      sections.push('■ 繰越（過去月の未完了）\n' + carryLines.join('\n'))
    }

    const globalLines: string[] = []
    if (remindDay10 && !globalTask?.expense_confirmed_at) {
      globalLines.push(`  □ 社長経費確認（期日: 10日）${overdueMark(day, 10)}`)
    }
    if (remindDay20 && !globalTask?.payment_report_confirmed_at) {
      globalLines.push(`  □ 支払・報酬 請求書チェック出し（期日: 20日）${overdueMark(day, 20)}`)
    }
    if (remindLastDay && !globalTask?.withholding_confirmed_at) {
      globalLines.push(`  □ 源泉所得税確認（期日: 月末）${overdueMark(day, lastDay)}`)
    }
    if (globalLines.length > 0) sections.push('■ グローバルタスク\n' + globalLines.join('\n'))

    if (remindDay15) {
      const unsentClients = clientRecords.filter((r) => !r.invoice_sent_at)
      if (unsentClients.length > 0) {
        const lines = unsentClients.map((r) => `  □ ${r.clients?.name ?? '?'}${overdueMark(day, 15)}`)
        sections.push(`■ クライアント — 請求書送付（期日: 15日）\n${lines.join('\n')}`)
      }

      const unreserved = records.filter((r) => !r.payment_reserved_at)
      if (unreserved.length > 0) {
        const lines = unreserved.map((r) =>
          `  □ ${r.assignments?.contractors?.name ?? '?'}（担当: ${r.assignments?.clients?.name ?? '?'}）${overdueMark(day, 15)}`
        )
        sections.push(`■ 委託者 — 支払い予約（期日: 15日）\n${lines.join('\n')}`)
      }
    }

    if (remindDay25) {
      const unconfirmedClients = clientRecords.filter((r) => !r.payment_confirmed_at)
      if (unconfirmedClients.length > 0) {
        const lines = unconfirmedClients.map((r) => `  □ ${r.clients?.name ?? '?'}${overdueMark(day, 25)}`)
        sections.push(`■ クライアント — 入金確認（期日: 25日）\n${lines.join('\n')}`)
      }
    }

    if (remindDay10) {
      const unreceived = records.filter((r) => !r.invoice_received_at)
      if (unreceived.length > 0) {
        const lines = unreceived.map((r) =>
          `  □ ${r.assignments?.contractors?.name ?? '?'}（担当: ${r.assignments?.clients?.name ?? '?'}）${overdueMark(day, 10)}`
        )
        sections.push(`■ 委託者 — 請求書受領（期日: 10日）\n${lines.join('\n')}`)
      }
    }

    if (remindLastDay) {
      const unpaid = records.filter((r) => !r.contractor_paid_at)
      if (unpaid.length > 0) {
        const lines = unpaid.map((r) =>
          `  □ ${r.assignments?.contractors?.name ?? '?'}（担当: ${r.assignments?.clients?.name ?? '?'}）${overdueMark(day, lastDay)}`
        )
        sections.push(`■ 委託者 — 支払い確認（期日: 月末）\n${lines.join('\n')}`)
      }

      const yearMonth = year * 100 + month
      const unfinishedCustomTasks = customTasks.filter(
        (t) => (t.months.length === 0 || t.months.includes(month)) && !t.completed_months.includes(yearMonth)
      )
      if (unfinishedCustomTasks.length > 0) {
        const lines = unfinishedCustomTasks.map((t) => `  □ ${t.title}`)
        sections.push(`■ カスタムタスク（期日: 月末）\n${lines.join('\n')}`)
      }
    }

    // 送るべき中身（タスク or 監視アラート）が何も無ければ送信しない。
    if (sections.length === 0 && !alertMsg) {
      await recordCronSuccess('remind')
      return Response.json({ ok: true, skipped: true, reason: 'no pending tasks in reminder window' })
    }

    const totalCount = sections.reduce((acc, s) => acc + (s.match(/□/g)?.length ?? 0), 0)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
    const alertBlock = alertMsg ? `⚠ 監視アラート\n  ${alertMsg}\n\n` : ''
    const body = [
      alertBlock + `本日 ${year}年${month}月${day}日 時点で、以下のタスクが未対応です。`,
      '',
      sections.join('\n\n'),
      '',
      `確認はこちら: ${appUrl}`,
    ].join('\n')

    const resend = getResend()
    // noreply@resend.dev はResendの検証用ドメインのため、Resendアカウント本人のメールアドレス宛にしか届かない。
    // 他の宛先にも届けるには、Resendで独自ドメインを検証してfromをそのドメインに変更する必要がある。
    const { error: mailErr } = await resend.emails.send({
      from: 'keiri-v3 <noreply@resend.dev>',
      to: process.env.NOTIFICATION_EMAIL!,
      subject: `[経理確認] ${year}年${month}月 未対応タスク ${totalCount}件`,
      text: body,
    })

    if (mailErr) {
      console.error('[remind] mail send failed:', mailErr)
      return Response.json({ error: 'リマインドメールの送信に失敗しました。' }, { status: 500 })
    }
    await recordCronSuccess('remind')
    return Response.json({ ok: true, sent: true, totalCount })
  } catch (err) {
    return serverError(err)
  }
}
