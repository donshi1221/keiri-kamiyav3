import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyCustomGlobalTasks } from '@/lib/schema'
import { asc } from 'drizzle-orm'

export async function GET() {
  try {
    const data = await db.select().from(monthlyCustomGlobalTasks).orderBy(asc(monthlyCustomGlobalTasks.created_at))
    return Response.json(data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const title = body.title as string
    const months = (body.months ?? []) as number[]

    if (!title?.trim()) {
      return Response.json({ error: 'title is required' }, { status: 400 })
    }

    const [data] = await db.insert(monthlyCustomGlobalTasks).values({
      title: title.trim(),
      months,
    }).returning()
    return Response.json(data, { status: 201 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
