import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clientExpenses } from '@/lib/schema'
import { and, asc, eq } from 'drizzle-orm'
import { parseBody, clientExpenseCreateSchema } from '@/lib/validation'

// 指定月の自社経費（自社が直接払い、クライアントへ請求する分）を返す。
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

    const data = await db.query.clientExpenses.findMany({
      where: and(eq(clientExpenses.year, year), eq(clientExpenses.month, month)),
      orderBy: [asc(clientExpenses.created_at)],
    })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(clientExpenseCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data

    const [inserted] = await db.insert(clientExpenses).values({
      client_id: body.client_id,
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
