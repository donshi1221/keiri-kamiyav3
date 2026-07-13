import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { taxAdviceEntries } from '@/lib/schema'
import { desc } from 'drizzle-orm'

export async function GET() {
  try {
    const data = await db.select().from(taxAdviceEntries).orderBy(desc(taxAdviceEntries.created_at))
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const [data] = await db.insert(taxAdviceEntries).values({
      title: body.title,
      body: body.body,
      source_type: 'manual',
    }).returning()
    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
