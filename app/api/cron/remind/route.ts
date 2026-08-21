import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyRecords, monthlyClientRecords, monthlyGlobalTasks, monthlyCustomGlobalTasks, monthlyPayrollRecords, payrollReimbursementItems, expenseUploads } from '@/lib/schema'
import { and, eq, gte, lt } from 'drizzle-orm'
import { getResend } from '@/lib/resend'
import { nowJST, getLastDayOfMonth, isInReminderWindow, TZ } from '@/lib/dates'
import { fromZonedTime } from 'date-fns-tz'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { computeCarryOver } from '@/lib/carry-over'
import { recordCronSuccess, checkCronStale } from '@/lib/cron-monitor'
import { payrollAmountsOfRecord, payrollReimbursementTotalsByRecipient, payrollTransferAmount } from '@/lib/payroll'
import { peekExpenseUploadToken } from '@/lib/expense-token'
import { CRON_STALE_ALERT_DAYS, PAYROLL_DEFAULT_PAY_DAY } from '@/lib/config'

// 代表への「経費未提出」Slack催促。メール本文の要否（送るべき中身の有無）とは無関係の別チャンネルなので、
// メール側の early return（201行目付近）より前で判定する。失敗しても cron 全体は落とさない。
async function sendSlackExpenseReminder(year: number, month: number, day: number): Promise<'sent' | 'skipped'> {
  const webhookUrl = process.env.SLACK_EXPENSE_REMINDER_WEBHOOK_URL
  if (!webhookUrl) return 'skipped'
  if (!isInReminderWindow(day, 10)) return 'skipped'

  // 当月（JST）に提出済みの経費が1件でもあれば、もう催促する必要がない。
  // submitted_at は timestamptz なので、JST の月初〜翌月初をUTCへ変換した範囲で絞り込む。
  const monthStartUtc = fromZonedTime(new Date(year, month - 1, 1), TZ)
  const monthEndUtc = fromZonedTime(new Date(year, month, 1), TZ)
  const [submitted] = await db
    .select({ id: expenseUploads.id })
    .from(expenseUploads)
    .where(and(gte(expenseUploads.submitted_at, monthStartUtc.toISOString()), lt(expenseUploads.submitted_at, monthEndUtc.toISOString())))
    .limit(1)
  if (submitted) return 'skipped'

  // 受付URLを配る前に催促しても意味が無いため、未発行なら送らない（トークンはここでは発行しない）。
  const token = await peekExpenseUploadToken()
  if (!token) return 'skipped'

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  // メンションは <@メンバーID> 形式でないと通知が飛ばない（@名前 の文字列では飾りにしかならない）。
  // 誰に付けるかは運用の話なのでコードに固定せず、環境変数（未設定ならメンション無し）にする。
  const mentionId = process.env.SLACK_EXPENSE_REMINDER_MENTION_ID
  // メンションは独立した行にする。本文と繋げると通知プレビューで文頭が読めなくなるため。
  const mention = mentionId ? `<@${mentionId}>\n` : ''
  const text = [
    `${mention}*【経費提出のお願い】*`,
    '',
    `${month}月分の経費（レシート・交通費明細など）の提出をお願いします。`,
    '期日：毎月10日',
    '',
    `提出はこちら：${appUrl}/expense/${token}`,
  ].join('\n')

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    // WebhookのURL失効などはHTTPエラーで返る。通信例外と同じく、催促失敗でcronは落とさずログだけ残す。
    if (!res.ok) console.error('[remind] slack expense reminder failed:', res.status, await res.text())
  } catch (err) {
    console.error('[remind] slack expense reminder failed:', err)
  }
  return 'sent'
}

// 関数のタイムアウト上限（秒）。委託者・クライアントを全件走査しメール送信まで行うため、
// 既定の短いタイムアウトだと途中で切れうる。Vercel の仕様上リテラルで指定する必要がある。
export const maxDuration = 60

function overdueMark(day: number, dueDay: number): string {
  return day > dueDay ? '（期限超過）' : ''
}

// クライアント名に内訳名を添える（内訳名がある内訳のみ「クライアント / 内訳」表記にする）。
function clientLabel(r: { clients: { name: string } | null; label_snapshot: string | null }): string {
  const name = r.clients?.name ?? '?'
  const label = r.label_snapshot?.trim()
  return label ? `${name} / ${label}` : name
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

    const [records, clientRecords, globalTask, customTasks, payrollRecords, payrollReimbursements] = await Promise.all([
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
        columns: { invoice_sent_at: true, payment_confirmed_at: true, label_snapshot: true },
        with: { clients: { columns: { name: true } } },
      }),
      db.query.monthlyGlobalTasks.findFirst({
        where: and(eq(monthlyGlobalTasks.year, year), eq(monthlyGlobalTasks.month, month)),
      }),
      db.select().from(monthlyCustomGlobalTasks),
      // 役員報酬・給与。支払日が人ごとに違うため、期日判定に使う pay_day を対象者から結合して取る。
      db.query.monthlyPayrollRecords.findMany({
        where: and(eq(monthlyPayrollRecords.year, year), eq(monthlyPayrollRecords.month, month)),
        with: { payroll_recipients: { columns: { name: true, pay_day: true } } },
      }),
      // 立替経費の精算。振込額は明細の合計を足した金額なので、リマインドでも必ず同じ足し算をする
      //（メールの金額だけ立替を落とすと、振込作業がそのまま不足額で実行されてしまう）。
      db
        .select({
          recipient_id: payrollReimbursementItems.recipient_id,
          amount: payrollReimbursementItems.amount,
        })
        .from(payrollReimbursementItems)
        .where(and(eq(payrollReimbursementItems.year, year), eq(payrollReimbursementItems.month, month))),
    ])
    const reimbursementTotals = payrollReimbursementTotalsByRecipient(payrollReimbursements)

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
        const lines = unsentClients.map((r) => `  □ ${clientLabel(r)}${overdueMark(day, 15)}`)
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
        const lines = unconfirmedClients.map((r) => `  □ ${clientLabel(r)}${overdueMark(day, 25)}`)
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

    // 役員報酬・給与の振込。期日（支払日）が人ごとに違うため、まとめて1つの窓では判定できない。
    // 行ごとにその人の支払日で窓に入っているかを見る。月末を超える指定は末日に丸める（画面と同じ扱い）。
    const unpaidPayroll = payrollRecords
      .filter((p) => !p.paid_at)
      .map((p) => ({ p, dueDay: Math.min(p.payroll_recipients?.pay_day ?? PAYROLL_DEFAULT_PAY_DAY, lastDay) }))
      .filter(({ dueDay }) => isInReminderWindow(day, dueDay))
    if (unpaidPayroll.length > 0) {
      const lines = unpaidPayroll.map(({ p, dueDay }) =>
        `  □ ${p.payroll_recipients?.name ?? '?'}（振込額 ¥${payrollTransferAmount(payrollAmountsOfRecord(p), reimbursementTotals[p.recipient_id] ?? 0).toLocaleString()}）${overdueMark(day, dueDay)}`
      )
      sections.push(`■ 役員報酬・給与 — 振込\n${lines.join('\n')}`)
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

    // メール本文の要否とは無関係に、Slack催促は毎日判定する（早期returnより前に置く）。
    const slackExpenseReminder = await sendSlackExpenseReminder(year, month, day)

    // 送るべき中身（タスク or 監視アラート）が何も無ければ送信しない。
    if (sections.length === 0 && !alertMsg) {
      await recordCronSuccess('remind')
      return Response.json({ ok: true, skipped: true, reason: 'no pending tasks in reminder window', slackExpenseReminder })
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
    return Response.json({ ok: true, sent: true, totalCount, slackExpenseReminder })
  } catch (err) {
    return serverError(err)
  }
}
