import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clients } from '@/lib/schema'
import { asc } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'

export async function GET() {
  try {
    const data = await db.select().from(clients).orderBy(asc(clients.created_at))
    return Response.json(data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const [data] = await db.insert(clients).values({
      name: body.name,
      contact_person: body.contact_person ?? null,
      billing_amount: body.billing_amount ?? 0,
      contract_start: body.contract_start ?? null,
      contract_months: body.contract_months ? Number(body.contract_months) : null,
      notes: body.notes ?? null,
    }).returning()

    const today = nowJST()
    await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)

    return Response.json(data, { status: 201 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
