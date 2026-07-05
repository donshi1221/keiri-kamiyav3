import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { assignments, clients, monthlyRecords, monthlyClientRecords, monthlyGlobalTasks } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const today = nowJST()
    const year = today.getFullYear()
    const month = today.getMonth() + 1

    const activeAssignments = await db.select({ id: assignments.id }).from(assignments).where(eq(assignments.active, true))

    if (activeAssignments.length > 0) {
      await db.insert(monthlyRecords)
        .values(activeAssignments.map((a) => ({ year, month, assignment_id: a.id })))
        .onConflictDoNothing()
    }

    const allClients = await db.select({ id: clients.id }).from(clients)

    if (allClients.length > 0) {
      await db.insert(monthlyClientRecords)
        .values(allClients.map((c) => ({ year, month, client_id: c.id })))
        .onConflictDoNothing()
    }

    await db.insert(monthlyGlobalTasks)
      .values({ year, month })
      .onConflictDoNothing()

    return Response.json({ ok: true, year, month, assignmentCount: activeAssignments.length })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
