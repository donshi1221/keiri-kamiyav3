import { db } from './db'
import { assignments, clients, monthlyRecords, monthlyClientRecords, monthlyGlobalTasks } from './schema'
import { eq } from 'drizzle-orm'

function isClientActiveForMonth(
  client: { contract_start: string | null; contract_months: number | null },
  year: number,
  month: number
): boolean {
  if (!client.contract_start) return true
  const [startYearStr, startMonthStr] = client.contract_start.split('-')
  const startYear = Number(startYearStr)
  const startMonth = Number(startMonthStr)
  const idx = year * 12 + month - (startYear * 12 + startMonth)
  if (idx < 0) return false
  if (client.contract_months == null) return true
  return idx < client.contract_months
}

export async function generateMonthlyRecords(year: number, month: number) {
  const activeAssignments = await db.select({
    id: assignments.id,
    contractor_payout_amount: assignments.contractor_payout_amount,
  }).from(assignments).where(eq(assignments.active, true))

  if (activeAssignments.length > 0) {
    await db.insert(monthlyRecords)
      .values(activeAssignments.map((a) => ({
        year,
        month,
        assignment_id: a.id,
        payout_amount_snapshot: a.contractor_payout_amount,
      })))
      .onConflictDoNothing()
  }

  const allClients = await db.select({
    id: clients.id,
    billing_amount: clients.billing_amount,
    contract_start: clients.contract_start,
    contract_months: clients.contract_months,
  }).from(clients)

  const activeClients = allClients.filter((c) => isClientActiveForMonth(c, year, month))

  if (activeClients.length > 0) {
    await db.insert(monthlyClientRecords)
      .values(activeClients.map((c) => ({
        year,
        month,
        client_id: c.id,
        billing_amount_snapshot: c.billing_amount,
      })))
      .onConflictDoNothing()
  }

  await db.insert(monthlyGlobalTasks)
    .values({ year, month })
    .onConflictDoNothing()

  return { assignmentCount: activeAssignments.length, clientCount: activeClients.length }
}
