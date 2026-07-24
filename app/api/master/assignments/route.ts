import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { assignments, monthlyRecords } from '@/lib/schema'
import { asc, sql } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { parseBody, assignmentCreateSchema } from '@/lib/validation'

export async function GET() {
  try {
    const data = await db.query.assignments.findMany({
      orderBy: [asc(assignments.created_at)],
      with: {
        contractors: { columns: { id: true, name: true, contractor_type: true } },
        clients: { columns: { id: true, name: true } },
      },
    })

    // アサインごとの支払い実績を集計する。支払確認(contractor_paid_at)済みの月だけを対象に、
    // 回数（=支払った月数）と本数（=その月の支払対象本数の合計）をまとめる。編集者の累計表示に使う。
    const paidRows = await db
      .select({
        assignment_id: monthlyRecords.assignment_id,
        paid_count: sql<number>`count(*) filter (where ${monthlyRecords.contractor_paid_at} is not null)`,
        paid_video_count: sql<number>`coalesce(sum(${monthlyRecords.delivered_video_count}) filter (where ${monthlyRecords.contractor_paid_at} is not null), 0)`,
      })
      .from(monthlyRecords)
      .groupBy(monthlyRecords.assignment_id)
    const paidById = new Map(paidRows.map((r) => [r.assignment_id, r]))

    const withPaid = data.map((a) => ({
      ...a,
      paid_count: Number(paidById.get(a.id)?.paid_count ?? 0),
      paid_video_count: Number(paidById.get(a.id)?.paid_video_count ?? 0),
    }))
    return Response.json(withPaid)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(assignmentCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data
    const [inserted] = await db.insert(assignments).values({
      contractor_id: body.contractor_id,
      client_id: body.client_id,
      role_name: body.role_name ?? '撮影+台本',
      contractor_payout_amount: body.contractor_payout_amount ?? 0,
      payment_start_month: body.payment_start_month ? `${body.payment_start_month}-01` : null,
      payment_count: body.payment_count ?? null,
      spreadsheet_url: body.spreadsheet_url ?? null,
      active: body.active ?? true,
    }).returning()

    const data = await db.query.assignments.findFirst({
      where: (a, { eq }) => eq(a.id, inserted.id),
      with: {
        contractors: { columns: { id: true, name: true, contractor_type: true } },
        clients: { columns: { id: true, name: true } },
      },
    })

    const today = nowJST()
    await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)

    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
