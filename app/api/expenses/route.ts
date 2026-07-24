import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { expenses } from '@/lib/schema'
import { and, asc, eq } from 'drizzle-orm'
import { parseBody, expenseCreateSchema } from '@/lib/validation'

// 指定月の立替経費を返す。委託者側の一覧表示と、クライアント側への自動反映の両方に使う。
export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams
    const year = Number(searchParams.get('year'))
    const month = Number(searchParams.get('month'))
    if (
      !Number.isInteger(year) || year < 2000 || year > 3000 ||
      !Number.isInteger(month) || month < 1 || month > 12
    ) {
      return Response.json({ error: 'year / month の指定が不正です' }, { status: 400 })
    }

    const data = await db.query.expenses.findMany({
      where: and(eq(expenses.year, year), eq(expenses.month, month)),
      orderBy: [asc(expenses.created_at)],
    })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(expenseCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data

    const [inserted] = await db.insert(expenses).values({
      assignment_id: body.assignment_id,
      year: body.year,
      month: body.month,
      expense_date: body.expense_date,
      amount: body.amount,
      note: body.note ?? null,
    }).returning()

    return Response.json(inserted, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
