import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { oneTimeTasks } from '@/lib/schema'
import { asc } from 'drizzle-orm'

export async function GET() {
  try {
    // 期日の早い順に返す。同日なら作成順。
    const data = await db.select().from(oneTimeTasks)
      .orderBy(asc(oneTimeTasks.due_date), asc(oneTimeTasks.created_at))
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

// YYYY-MM-DD 形式の日付だけを受け付ける（カレンダー input type="date" の値と一致）。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const title = (body.title as string | undefined)?.trim()
    const dueDate = body.due_date as string | undefined

    if (!title) {
      return Response.json({ error: 'タスク名を入力してください。' }, { status: 400 })
    }
    if (!dueDate || !DATE_RE.test(dueDate) || Number.isNaN(Date.parse(dueDate))) {
      return Response.json({ error: '日付を正しく入力してください。' }, { status: 400 })
    }

    const [data] = await db.insert(oneTimeTasks).values({
      title,
      due_date: dueDate,
    }).returning()
    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
