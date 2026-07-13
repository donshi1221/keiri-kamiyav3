import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { taxChatSessions } from '@/lib/schema'
import { desc } from 'drizzle-orm'

export async function GET() {
  try {
    const data = await db.select().from(taxChatSessions).orderBy(desc(taxChatSessions.created_at))
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const [data] = await db.insert(taxChatSessions).values({
      title: body.title ?? '新しい会話',
    }).returning()
    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
