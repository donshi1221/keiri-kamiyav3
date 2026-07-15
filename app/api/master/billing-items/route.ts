import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clientBillingItems } from '@/lib/schema'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { parseBody, billingItemCreateSchema } from '@/lib/validation'

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(billingItemCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data

    const [data] = await db.insert(clientBillingItems).values({
      client_id: body.client_id,
      label: body.label?.trim() ?? '',
      billing_amount: body.billing_amount ?? 0,
      contract_start: body.contract_start ?? null,
      contract_months: body.contract_months ?? null,
      active: body.active ?? true,
      sort_order: body.sort_order ?? 0,
    }).returning()

    // 追加した内訳が当月の契約期間内なら、当月の請求記録も生成しておく（冪等）。
    const today = nowJST()
    await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)

    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
