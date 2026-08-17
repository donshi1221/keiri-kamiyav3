import { db } from '@/lib/db'
import { monthlyRecords, monthlyClientRecords, monthlyGlobalTasks, monthlyCustomGlobalTasks, oneTimeTasks, moneyforwardExpenses, moneyforwardTokens, expenses, clientExpenses, invoiceUploads, monthlyPayrollRecords } from '@/lib/schema'
import { and, eq, asc, sql } from 'drizzle-orm'
import type { InvoiceAlertCounts } from '@/lib/ui-types'
import { nowJST } from '@/lib/dates'
import { computeCarryOver } from '@/lib/carry-over'
import { getValidAccessToken } from '@/lib/moneyforward'
import { ONE_TIME_TASK_WINDOW_DAYS } from '@/lib/config'
import DashboardClient from './components/dashboard-client'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string; mf_error?: string; mf_connected?: string }>
}) {
  const params = await searchParams
  const today = nowJST()
  const year = params.year ? Number(params.year) : today.getFullYear()
  const month = params.month ? Number(params.month) : today.getMonth() + 1

  const [
    records,
    clientRecords,
    globalTask,
    allCustomTasks,
    allOneTimeTasks,
    mfExpense,
    mfToken,
    clientBillingCounts,
    assignmentPaymentCountRows,
    allRecordsForCarryOver,
    allClientRecordsForCarryOver,
    allGlobalTasksForCarryOver,
    monthExpenses,
    monthClientExpenses,
    invoiceStatusCountRows,
    payrollRecords,
  ] = await Promise.all([
    db.query.monthlyRecords.findMany({
      where: and(eq(monthlyRecords.year, year), eq(monthlyRecords.month, month)),
      orderBy: [asc(monthlyRecords.created_at)],
      with: {
        assignments: {
          with: {
            contractors: { columns: { id: true, name: true, contractor_type: true, unit_price: true } },
            clients: { columns: { id: true, name: true } },
          },
        },
      },
    }),
    db.query.monthlyClientRecords.findMany({
      where: and(eq(monthlyClientRecords.year, year), eq(monthlyClientRecords.month, month)),
      orderBy: [asc(monthlyClientRecords.created_at)],
      with: {
        clients: { columns: { id: true, name: true } },
        billing_items: { columns: { id: true, label: true, contract_months: true } },
      },
    }),
    db.query.monthlyGlobalTasks.findFirst({
      where: and(eq(monthlyGlobalTasks.year, year), eq(monthlyGlobalTasks.month, month)),
    }),
    db.select().from(monthlyCustomGlobalTasks).orderBy(asc(monthlyCustomGlobalTasks.created_at)),
    db.select().from(oneTimeTasks).orderBy(asc(oneTimeTasks.due_date), asc(oneTimeTasks.created_at)),
    db.query.moneyforwardExpenses.findFirst({
      where: and(eq(moneyforwardExpenses.year, year), eq(moneyforwardExpenses.month, month)),
    }),
    db.select({ updated_at: moneyforwardTokens.updated_at }).from(moneyforwardTokens).limit(1),
    // 内訳ごとの送付済み・入金確認済み件数をSQL側で集計（請求回数超過の判定に使用）
    db.select({
      billing_item_id: monthlyClientRecords.billing_item_id,
      billed: sql<number>`count(*) filter (where ${monthlyClientRecords.invoice_sent_at} is not null)`,
      paid: sql<number>`count(*) filter (where ${monthlyClientRecords.payment_confirmed_at} is not null)`,
    }).from(monthlyClientRecords).groupBy(monthlyClientRecords.billing_item_id),
    db.select({
      assignment_id: monthlyRecords.assignment_id,
      scheduled: sql<number>`count(*)`,
      paid: sql<number>`count(*) filter (where ${monthlyRecords.contractor_paid_at} is not null)`,
    }).from(monthlyRecords).groupBy(monthlyRecords.assignment_id),
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
    db.select({
      year: monthlyGlobalTasks.year,
      month: monthlyGlobalTasks.month,
      expense_confirmed_at: monthlyGlobalTasks.expense_confirmed_at,
      payment_report_confirmed_at: monthlyGlobalTasks.payment_report_confirmed_at,
      withholding_confirmed_at: monthlyGlobalTasks.withholding_confirmed_at,
    }).from(monthlyGlobalTasks),
    // 立替経費（代行者に紐づく）。委託者への支払いとクライアントへの請求の両方に反映する。
    db.query.expenses.findMany({
      where: and(eq(expenses.year, year), eq(expenses.month, month)),
      orderBy: [asc(expenses.created_at)],
    }),
    // 自社経費（自社が直接払う分）。委託者への支払いには乗らず、クライアントへの請求にだけ加算する。
    db.query.clientExpenses.findMany({
      where: and(eq(clientExpenses.year, year), eq(clientExpenses.month, month)),
      orderBy: [asc(clientExpenses.created_at)],
    }),
    // 受け付けた請求書の状態別件数。請求書は月に紐づかない（対象月が読み取れない行もある）ため、
    // 表示中の月では絞らず全件を数える。
    db.select({
      status: invoiceUploads.status,
      count: sql<number>`count(*)`,
    }).from(invoiceUploads).groupBy(invoiceUploads.status),
    // 役員報酬・給与。種別ラベルと支払日はマスタ側にしか無いため対象者を結合して取る。
    db.query.monthlyPayrollRecords.findMany({
      where: and(eq(monthlyPayrollRecords.year, year), eq(monthlyPayrollRecords.month, month)),
      orderBy: [asc(monthlyPayrollRecords.created_at)],
      with: {
        payroll_recipients: { columns: { id: true, name: true, kind: true, pay_day: true } },
      },
    }),
  ])

  const carryOver = computeCarryOver(
    allRecordsForCarryOver,
    allClientRecordsForCarryOver,
    today.getFullYear(),
    today.getMonth() + 1,
    allGlobalTasksForCarryOver,
    allCustomTasks
  )

  const customTasks = allCustomTasks.filter(
    (t) => t.months.length === 0 || t.months.includes(month)
  )

  // 単発タスク: 未完了 かつ 期日の月が「表示中の月」以前 のものだけ渡す。
  // これで期日の月になったら現れ、完了するまで翌月以降も残る（期限超過でも見逃さない）。
  const viewedYearMonth = year * 100 + month
  const oneTimeTasksForMonth = allOneTimeTasks.filter((t) => {
    if (t.completed_at) return false
    const [dy, dm] = t.due_date.split('-').map(Number)
    return dy * 100 + dm <= viewedYearMonth
  })

  // キーは内訳(billing_item_id)。回数超過は内訳ごとに判定する。
  const billedCounts: Record<string, number> = {}
  const paidCounts: Record<string, number> = {}
  for (const row of clientBillingCounts) {
    billedCounts[row.billing_item_id] = Number(row.billed)
    paidCounts[row.billing_item_id] = Number(row.paid)
  }
  const assignmentPaymentCounts: Record<string, { scheduled: number; paid: number }> = {}
  for (const row of assignmentPaymentCountRows) {
    assignmentPaymentCounts[row.assignment_id] = { scheduled: Number(row.scheduled), paid: Number(row.paid) }
  }

  // 人の対応が要る請求書だけを数える。1件も無ければ null にしてカードごと出さない
  // （対応不要な情報でダッシュボードを騒がせないため）。
  const invoiceCounts: Record<string, number> = {}
  for (const row of invoiceStatusCountRows) invoiceCounts[row.status] = Number(row.count)
  const invoiceAlertCounts: InvoiceAlertCounts = {
    ng: invoiceCounts.ng ?? 0,
    hold: invoiceCounts.hold ?? 0,
    pending: invoiceCounts.pending ?? 0,
  }
  const invoiceAlert =
    invoiceAlertCounts.ng + invoiceAlertCounts.hold + invoiceAlertCounts.pending > 0
      ? invoiceAlertCounts
      : null

  // トークンの行が存在するだけでは「連携中」と言えない（リフレッシュトークン失効時も行は残る）。
  // 実際に有効なアクセストークンを取得できるかで連携状態を判定する。
  const mfHasToken = mfToken.length > 0
  const mfAccessToken = mfHasToken ? await getValidAccessToken() : null
  const mfConnected = mfAccessToken !== null
  // 行はあるが有効化できない＝連携が失効している状態。再連携を促すために区別する。
  const mfExpired = mfHasToken && !mfConnected

  return (
    <DashboardClient
      // 月ごとに別インスタンスとして作り直す。これが無いと「← 前月」などのクライアント遷移で
      // useState(records) 等のローカル状態が前の月のまま残り、見出しと表の中身がズレる。
      key={`${year}-${month}`}
      year={year}
      month={month}
      records={records}
      clientRecords={clientRecords}
      globalTask={globalTask ?? null}
      customTasks={customTasks}
      oneTimeTasks={oneTimeTasksForMonth}
      oneTimeWindowDays={ONE_TIME_TASK_WINDOW_DAYS}
      today={today.toISOString()}
      billedCounts={billedCounts}
      paidCounts={paidCounts}
      assignmentPaymentCounts={assignmentPaymentCounts}
      expenses={monthExpenses}
      clientExpenses={monthClientExpenses}
      mfExpense={mfExpense ? { amount: mfExpense.amount, syncedAt: mfExpense.synced_at } : null}
      mfConnected={mfConnected}
      mfExpired={mfExpired}
      mfError={params.mf_error ?? null}
      mfJustConnected={params.mf_connected === '1'}
      carryOver={carryOver}
      invoiceAlert={invoiceAlert}
      payrollRecords={payrollRecords}
    />
  )
}
