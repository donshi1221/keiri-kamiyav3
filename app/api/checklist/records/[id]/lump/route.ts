import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { assignments, contractors, monthlyRecords } from '@/lib/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { monthIndex, payoutLumpBlockReason, remainingMonths, resolveLumpMonths } from '@/lib/lump-sum'
import { parseBody, lumpSumCreateSchema } from '@/lib/validation'

// 委託者への残りの支払いを、この行1回の支払いにまとめる。
// 返り値は PATCH /api/checklist/records/[id] と同じ「更新後の行」。
export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/checklist/records/[id]/lump'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(lumpSumCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })

    const [row] = await db.select().from(monthlyRecords).where(eq(monthlyRecords.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
    const [found] = await db
      .select({
        payment_start_month: assignments.payment_start_month,
        payment_count: assignments.payment_count,
        contractor_type: contractors.contractor_type,
      })
      .from(assignments)
      .innerJoin(contractors, eq(assignments.contractor_id, contractors.id))
      .where(eq(assignments.id, row.assignment_id))

    const reason = payoutLumpBlockReason(row, found, found?.contractor_type)
    if (reason) return Response.json({ error: reason }, { status: 400 })
    // payoutLumpBlockReason が通った時点で支払開始月・回数はあり、残りは2以上。
    const resolved = resolveLumpMonths(
      remainingMonths(row, found.payment_start_month, found.payment_count)!,
      parsed.data.months,
    )
    if (!resolved.ok) return Response.json({ error: resolved.error }, { status: 400 })
    const months = resolved.months

    // まとめた後の月にすでに行があると、その月の分を二重に払うことになる。
    // どちらを残すかは人が決めることなので、自動で消さずに断る。
    const rowIndex = monthIndex(row.year, row.month)
    const [later] = await db
      .select({ year: monthlyRecords.year, month: monthlyRecords.month })
      .from(monthlyRecords)
      .where(
        and(
          eq(monthlyRecords.assignment_id, row.assignment_id),
          sql`${monthlyRecords.year} * 12 + ${monthlyRecords.month} between ${rowIndex + 1} and ${rowIndex + months - 1}`
        )
      )
      .orderBy(asc(monthlyRecords.year), asc(monthlyRecords.month))
      .limit(1)
    if (later) {
      return Response.json(
        { error: `${later.year}年${later.month}月の行がすでにあるため、まとめられません。` },
        { status: 409 }
      )
    }

    const [data] = await db.update(monthlyRecords)
      .set({ payout_amount_snapshot: parsed.data.total_amount, months_covered: months })
      .where(eq(monthlyRecords.id, id))
      .returning()
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

// まとめを取り消し、1か月分の行に戻す。金額はアサインの今の契約額に戻す。
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/checklist/records/[id]/lump'>
) {
  try {
    const { id } = await ctx.params
    const [row] = await db.select().from(monthlyRecords).where(eq(monthlyRecords.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
    if (row.months_covered <= 1) return Response.json({ error: 'この行はまとめていません。' }, { status: 400 })
    // 支払い済みの行はまとめた金額で払い終えているため、行だけ戻すと実際の支払いと食い違う。
    if (row.contractor_paid_at) return Response.json({ error: '支払い済みの行は取り消せません。' }, { status: 400 })

    const [assignment] = await db
      .select({ contractor_payout_amount: assignments.contractor_payout_amount })
      .from(assignments)
      .where(eq(assignments.id, row.assignment_id))
    if (!assignment) return Response.json({ error: 'アサインが見つかりません。' }, { status: 404 })

    const [data] = await db.update(monthlyRecords)
      .set({ months_covered: 1, payout_amount_snapshot: assignment.contractor_payout_amount })
      .where(eq(monthlyRecords.id, id))
      .returning()

    // 過去月の行でまとめていた場合、今月はまとめ行にカバーされて生成されていない。
    // 取り消した瞬間に今月の支払いが消えたままにならないよう、今月分をここで作る。
    const today = nowJST()
    const currentIndex = monthIndex(today.getFullYear(), today.getMonth() + 1)
    const rowIndex = monthIndex(row.year, row.month)
    if (rowIndex < currentIndex && rowIndex + row.months_covered - 1 >= currentIndex) {
      await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)
    }

    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}
