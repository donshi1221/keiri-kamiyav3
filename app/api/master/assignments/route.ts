import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { assignments } from '@/lib/schema'
import { asc } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { parseBody, assignmentCreateSchema } from '@/lib/validation'

export async function GET() {
  try {
    const data = await db.query.assignments.findMany({
      orderBy: [asc(assignments.created_at)],
      with: {
        contractors: { columns: { id: true, name: true, contractor_type: true } },
        clients: { columns: { id: true, name: true } },
      },
    })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(assignmentCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data
    const [inserted] = await db.insert(assignments).values({
      contractor_id: body.contractor_id,
      client_id: body.client_id,
      role_name: body.role_name ?? '撮影+台本',
      contractor_payout_amount: body.contractor_payout_amount ?? 0,
      spreadsheet_url: body.spreadsheet_url ?? null,
      active: body.active ?? true,
    }).returning()

    const data = await db.query.assignments.findFirst({
      where: (a, { eq }) => eq(a.id, inserted.id),
      with: {
        contractors: { columns: { id: true, name: true, contractor_type: true } },
        clients: { columns: { id: true, name: true } },
      },
    })

    const today = nowJST()
    await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)

    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
