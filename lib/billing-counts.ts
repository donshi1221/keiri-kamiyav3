import 'server-only'
import { db } from './db'
import { monthlyClientRecords } from './schema'
import { and, eq, isNotNull, sql } from 'drizzle-orm'

export async function getBilledCountByClient(clientId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(monthlyClientRecords)
    .where(and(eq(monthlyClientRecords.client_id, clientId), isNotNull(monthlyClientRecords.invoice_sent_at)))
  return Number(count)
}

export async function getPaidCountByClient(clientId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(monthlyClientRecords)
    .where(and(eq(monthlyClientRecords.client_id, clientId), isNotNull(monthlyClientRecords.payment_confirmed_at)))
  return Number(count)
}
