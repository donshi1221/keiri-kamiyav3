import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { payrollRecipients } from '@/lib/schema'
import { asc } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { parseBody, payrollRecipientCreateSchema } from '@/lib/validation'

export async function GET() {
  try {
    const data = await db.select().from(payrollRecipients).orderBy(asc(payrollRecipients.created_at))
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(payrollRecipientCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data
    const [data] = await db.insert(payrollRecipients).values({
      name: body.name,
      kind: body.kind,
      gross_amount: body.gross_amount ?? 0,
      health_insurance: body.health_insurance ?? 0,
      pension: body.pension ?? 0,
      employment_insurance: body.employment_insurance ?? 0,
      income_tax: body.income_tax ?? 0,
      resident_tax: body.resident_tax ?? 0,
      pay_day: body.pay_day ?? null,
      active: body.active ?? true,
    }).returning()

    // 登録した人が当月のダッシュボードにすぐ並ぶようにする（アサインの追加と同じ作法）。
    const today = nowJST()
    await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)

    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
