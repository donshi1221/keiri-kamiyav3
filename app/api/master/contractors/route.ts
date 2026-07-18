import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { contractors } from '@/lib/schema'
import { asc } from 'drizzle-orm'
import { parseBody, contractorCreateSchema } from '@/lib/validation'

export async function GET() {
  try {
    const data = await db.select().from(contractors).orderBy(asc(contractors.created_at))
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(contractorCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data
    const [data] = await db.insert(contractors).values({
      name: body.name,
      contractor_type: body.contractor_type ?? 'daiko',
      unit_price: body.unit_price ?? 0,
      email: body.email ?? null,
      notes: body.notes ?? null,
    }).returning()
    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
