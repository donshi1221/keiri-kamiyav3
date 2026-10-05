import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { assignments, contractors, expenses, monthlyRecords } from '@/lib/schema'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { laterRowBlockMessage, laterRowsInRange, monthIndex, payoutLaterRowBlockCause, payoutLumpBlockReason, remainingMonths, resolveLumpMonths } from '@/lib/lump-sum'
import { parseBody, lumpSumCreateSchema } from '@/lib/validation'
import type { MonthlyRecord } from '@/lib/schema'
import type { LumpLaterRow } from '@/lib/ui-types'

// まとめの可否判定と金額表示に使うアサインの情報（委託者の種別は contractors 側にある）。
async function loadAssignment(assignmentId: string) {
  const [found] = await db
    .select({
      payment_start_month: assignments.payment_start_month,
      payment_count: assignments.payment_count,
      contractor_payout_amount: assignments.contractor_payout_amount,
      contractor_type: contractors.contractor_type,
    })
    .from(assignments)
    .innerJoin(contractors, eq(assignments.contractor_id, contractors.id))
    .where(eq(assignments.id, assignmentId))
  return found
}

// 行の翌月〜支払期間の最後の月にすでにある同じアサインの行を、まとめに取り込めるかどうか付きで読む。
// 確認ダイアログの事前表示（GET）と、実際にまとめるとき（POST）で同じ判定を使う。
// masterAmount は控えが無い行の表示用（画面の報酬額と同じく、控え → マスタの契約額の順）。
async function loadLaterRows(row: MonthlyRecord, remaining: number, masterAmount: number): Promise<(LumpLaterRow & { id: string })[]> {
  const rowIndex = monthIndex(row.year, row.month)
  const from = rowIndex + 1
  const to = rowIndex + remaining - 1
  const [rows, expenseMonths] = await Promise.all([
    db
      .select()
      .from(monthlyRecords)
      .where(
        and(
          eq(monthlyRecords.assignment_id, row.assignment_id),
          sql`${monthlyRecords.year} * 12 + ${monthlyRecords.month} between ${from} and ${to}`
        )
      )
      .orderBy(asc(monthlyRecords.year), asc(monthlyRecords.month)),
    db
      .select({ year: expenses.year, month: expenses.month })
      .from(expenses)
      .where(
        and(
          eq(expenses.assignment_id, row.assignment_id),
          sql`${expenses.year} * 12 + ${expenses.month} between ${from} and ${to}`
        )
      ),
  ])
  const monthsWithExpense = new Set(expenseMonths.map((e) => monthIndex(e.year, e.month)))
  return rows.map((r) => {
    const cause = payoutLaterRowBlockCause(r, monthsWithExpense.has(monthIndex(r.year, r.month)))
    return {
      id: r.id,
      year: r.year,
      month: r.month,
      amount: r.payout_amount_snapshot ?? masterAmount,
      absorbable: cause === null,
      reason: cause === null ? null : laterRowBlockMessage(r.year, r.month, cause),
    }
  })
}

// 確認ダイアログ用。まとめる月数を選ぶ前に「どの月の行が取り込まれるか／どの月数は選べないか」を
// 画面で見せるため、後ろの月の既存行を返す（サーバーに断られるまで分からない状態を避ける）。
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/checklist/records/[id]/lump'>
) {
  try {
    const { id } = await ctx.params
    const [row] = await db.select().from(monthlyRecords).where(eq(monthlyRecords.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
    const found = await loadAssignment(row.assignment_id)

    const reason = payoutLumpBlockReason(row, found, found?.contractor_type)
    if (reason) return Response.json({ error: reason }, { status: 400 })
    const remaining = remainingMonths(row, found.payment_start_month, found.payment_count)!

    const laterRows: LumpLaterRow[] = (await loadLaterRows(row, remaining, found.contractor_payout_amount))
      .map(({ id: _id, ...rest }) => rest)
    return Response.json({ laterRows })
  } catch (err) {
    return serverError(err)
  }
}

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
    const found = await loadAssignment(row.assignment_id)

    const reason = payoutLumpBlockReason(row, found, found?.contractor_type)
    if (reason) return Response.json({ error: reason }, { status: 400 })
    // payoutLumpBlockReason が通った時点で支払開始月・回数はあり、残りは2以上。
    const remaining = remainingMonths(row, found.payment_start_month, found.payment_count)!
    const resolved = resolveLumpMonths(remaining, parsed.data.months)
    if (!resolved.ok) return Response.json({ error: resolved.error }, { status: 400 })
    const months = resolved.months

    // まとめる範囲の月にすでに行があると、その月の分を二重に払うことになる。
    // 月初の自動生成でできただけの手つかずの行は、まとめに取り込んで消す。
    // 受領・支払いの記録や立替経費が付いた行は消すと記録が失われるので、1つでもあれば何も変えずに断る。
    const inRange = laterRowsInRange(
      await loadLaterRows(row, remaining, found.contractor_payout_amount),
      row.year, row.month, months,
    )
    const blocked = inRange.find((r) => !r.absorbable)
    if (blocked) return Response.json({ error: blocked.reason }, { status: 409 })

    const update = db.update(monthlyRecords)
      .set({ payout_amount_snapshot: parsed.data.total_amount, months_covered: months })
      .where(eq(monthlyRecords.id, id))
      .returning()

    if (inRange.length === 0) {
      const [data] = await update
      return Response.json(data)
    }

    // 取り込む行の削除とまとめの更新は、片方だけ成功すると「行は消えたのにまとめていない」
    // 「まとめたのに後ろの月の行が残って二重払い」になる。neon-http は対話的なトランザクション
    // （db.transaction）が使えないが、db.batch は1回の通信で全部成功か全部失敗かになるためこれを使う。
    // where に手つかずの条件を重ねているのは、判定から削除までの間に人が付けた記録を消さないための二重の歯止め
    // （立替経費だけは別テーブルなので、直前の判定に任せる）。
    const [, [data]] = await db.batch([
      db.delete(monthlyRecords).where(
        and(
          inArray(monthlyRecords.id, inRange.map((r) => r.id)),
          isNull(monthlyRecords.invoice_received_at),
          isNull(monthlyRecords.payment_reserved_at),
          isNull(monthlyRecords.contractor_paid_at),
          isNull(monthlyRecords.actual_payout_amount),
          isNull(monthlyRecords.delivered_video_count),
          eq(monthlyRecords.months_covered, 1)
        )
      ),
      update,
    ])
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
