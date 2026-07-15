import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyCustomGlobalTasks } from '@/lib/schema'
import { asc } from 'drizzle-orm'

export async function GET() {
  try {
    const data = await db.select().from(monthlyCustomGlobalTasks).orderBy(asc(monthlyCustomGlobalTasks.created_at))
    return Response.json(data)
  } catch (err) {
    return serverError(err)
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

    // 表示用の日にち。1〜31の整数だけ受け付け、それ以外・未指定は null（日付なし）とする。
    const rawDay = Number(body.day)
    const day = Number.isInteger(rawDay) && rawDay >= 1 && rawDay <= 31 ? rawDay : null

    const [data] = await db.insert(monthlyCustomGlobalTasks).values({
      title: title.trim(),
      months,
      day,
    }).returning()
    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
