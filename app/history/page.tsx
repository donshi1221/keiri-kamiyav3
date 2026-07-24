import { db } from '@/lib/db'
import { monthlyRecords, monthlyClientRecords, monthlyGlobalTasks } from '@/lib/schema'
import { and, eq, asc } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import HistoryClient from './history-client'

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>
}) {
  const params = await searchParams
  const today = nowJST()
  const defaultDate = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const year = params.year ? Number(params.year) : defaultDate.getFullYear()
  const month = params.month ? Number(params.month) : defaultDate.getMonth() + 1

  const [records, clientRecords, globalTask] = await Promise.all([
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
      },
    }),
    db.query.monthlyGlobalTasks.findFirst({
      where: and(eq(monthlyGlobalTasks.year, year), eq(monthlyGlobalTasks.month, month)),
    }),
  ])

  return (
    <HistoryClient
      year={year}
      month={month}
      records={records}
      clientRecords={clientRecords}
      globalTask={globalTask ?? null}
    />
  )
}
