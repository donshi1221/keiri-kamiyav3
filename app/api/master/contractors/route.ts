import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { contractors } from '@/lib/schema'
import { asc } from 'drizzle-orm'

export async function GET() {
  try {
    const data = await db.select().from(contractors).orderBy(asc(contractors.created_at))
    return Response.json(data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const [data] = await db.insert(contractors).values({
      name: body.name,
      contractor_type: body.contractor_type ?? 'daiko',
      email: body.email ?? null,
      notes: body.notes ?? null,
    }).returning()
    return Response.json(data, { status: 201 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
