import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { payrollReimbursementItems } from '@/lib/schema'
import { and, asc, eq } from 'drizzle-orm'
import { parseBody, payrollReimbursementCreateSchema } from '@/lib/validation'

// 指定月の立替精算の明細。月次レコードではなく (recipient_id, year, month) で持つので、
// 月次レコードが未生成の月（＝翌月に精算する分を先に積んだ場合）でも同じ条件で取り出せる。
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

    const data = await db
      .select()
      .from(payrollReimbursementItems)
      .where(and(eq(payrollReimbursementItems.year, year), eq(payrollReimbursementItems.month, month)))
      .orderBy(asc(payrollReimbursementItems.created_at))
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(payrollReimbursementCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data

    const [inserted] = await db
      .insert(payrollReimbursementItems)
      .values({
        recipient_id: body.recipient_id,
        year: body.year,
        month: body.month,
        item_date: body.item_date ?? null,
        description: body.description,
        amount: body.amount,
      })
      .returning()

    return Response.json(inserted, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
