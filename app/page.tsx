import { db } from '@/lib/db'
import { monthlyRecords, monthlyClientRecords, monthlyGlobalTasks, monthlyCustomGlobalTasks, moneyforwardExpenses, moneyforwardTokens } from '@/lib/schema'
import { and, eq, asc, sql } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { computeCarryOver } from '@/lib/carry-over'
import { getValidAccessToken } from '@/lib/moneyforward'
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
    mfExpense,
    mfToken,
    clientBillingCounts,
    allRecordsForCarryOver,
    allClientRecordsForCarryOver,
  ] = await Promise.all([
    db.query.monthlyRecords.findMany({
      where: and(eq(monthlyRecords.year, year), eq(monthlyRecords.month, month)),
      orderBy: [asc(monthlyRecords.created_at)],
      with: {
        assignments: {
          with: {
            contractors: { columns: { id: true, name: true, contractor_type: true } },
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

  const carryOver = computeCarryOver(
    allRecordsForCarryOver,
    allClientRecordsForCarryOver,
    today.getFullYear(),
    today.getMonth() + 1
  )

  const customTasks = allCustomTasks.filter(
    (t) => t.months.length === 0 || t.months.includes(month)
  )

  // キーは内訳(billing_item_id)。回数超過は内訳ごとに判定する。
  const billedCounts: Record<string, number> = {}
  const paidCounts: Record<string, number> = {}
  for (const row of clientBillingCounts) {
    billedCounts[row.billing_item_id] = Number(row.billed)
    paidCounts[row.billing_item_id] = Number(row.paid)
  }

  // トークンの行が存在するだけでは「連携中」と言えない（リフレッシュトークン失効時も行は残る）。
  // 実際に有効なアクセストークンを取得できるかで連携状態を判定する。
  const mfHasToken = mfToken.length > 0
  const mfAccessToken = mfHasToken ? await getValidAccessToken() : null
  const mfConnected = mfAccessToken !== null
  // 行はあるが有効化できない＝連携が失効している状態。再連携を促すために区別する。
  const mfExpired = mfHasToken && !mfConnected

  return (
    <DashboardClient
      year={year}
      month={month}
      records={records}
      clientRecords={clientRecords}
      globalTask={globalTask ?? null}
      customTasks={customTasks}
      today={today.toISOString()}
      billedCounts={billedCounts}
      paidCounts={paidCounts}
      mfExpense={mfExpense ? { amount: mfExpense.amount, syncedAt: mfExpense.synced_at } : null}
      mfConnected={mfConnected}
      mfExpired={mfExpired}
      mfError={params.mf_error ?? null}
      mfJustConnected={params.mf_connected === '1'}
      carryOver={carryOver}
    />
  )
}
