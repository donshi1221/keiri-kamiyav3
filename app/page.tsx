import { db } from '@/lib/db'
import { monthlyRecords, monthlyClientRecords, monthlyGlobalTasks, monthlyCustomGlobalTasks, moneyforwardExpenses, moneyforwardTokens } from '@/lib/schema'
import { and, eq, isNotNull, asc } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import DashboardClient from './components/dashboard-client'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>
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
    allClientRecords,
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
        clients: {
          columns: { id: true, name: true, billing_amount: true, contract_start: true, contract_months: true },
        },
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
    db.select({
      client_id: monthlyClientRecords.client_id,
      invoice_sent_at: monthlyClientRecords.invoice_sent_at,
      payment_confirmed_at: monthlyClientRecords.payment_confirmed_at,
    }).from(monthlyClientRecords).where(
      // 片方でも null でないレコードを取得（billedCounts / paidCounts の集計用）
      isNotNull(monthlyClientRecords.client_id)
    ),
  ])

  const customTasks = allCustomTasks.filter(
    (t) => t.months.length === 0 || t.months.includes(month)
  )

  const billedCounts: Record<string, number> = {}
  const paidCounts: Record<string, number> = {}
  for (const r of allClientRecords) {
    if (r.invoice_sent_at) billedCounts[r.client_id] = (billedCounts[r.client_id] ?? 0) + 1
    if (r.payment_confirmed_at) paidCounts[r.client_id] = (paidCounts[r.client_id] ?? 0) + 1
  }

  return (
    <DashboardClient
      year={year}
      month={month}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      records={records as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientRecords={clientRecords as any}
      globalTask={globalTask ?? null}
      customTasks={customTasks}
      today={today.toISOString()}
      billedCounts={billedCounts}
      paidCounts={paidCounts}
      mfExpense={mfExpense ? { amount: mfExpense.amount, syncedAt: mfExpense.synced_at } : null}
      mfConnected={mfToken.length > 0}
    />
  )
}
