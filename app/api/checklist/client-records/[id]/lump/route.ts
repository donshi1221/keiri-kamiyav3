import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clientBillingItems, monthlyClientRecords } from '@/lib/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { clientLumpBlockReason, lumpLabel, monthIndex, remainingMonths, resolveLumpMonths } from '@/lib/lump-sum'
import { parseBody, lumpSumCreateSchema } from '@/lib/validation'

// クライアント請求の残りの月を、この行1回の請求にまとめる。
// 返り値は PATCH /api/checklist/client-records/[id] と同じ「更新後の行」。
export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/checklist/client-records/[id]/lump'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(lumpSumCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })

    const [row] = await db.select().from(monthlyClientRecords).where(eq(monthlyClientRecords.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
    const [item] = await db.select().from(clientBillingItems).where(eq(clientBillingItems.id, row.billing_item_id))

    const reason = clientLumpBlockReason(row, item)
    if (reason) return Response.json({ error: reason }, { status: 400 })
    // clientLumpBlockReason が通った時点で契約開始月・期間はあり、残りは2以上。
    const resolved = resolveLumpMonths(
      remainingMonths(row, item.contract_start, item.contract_months)!,
      parsed.data.months,
    )
    if (!resolved.ok) return Response.json({ error: resolved.error }, { status: 400 })
    const months = resolved.months

    // まとめた後の月にすでに行があると、その月の分を二重に請求することになる。
    // どちらを残すかは人が決めることなので、自動で消さずに断る。
    const rowIndex = monthIndex(row.year, row.month)
    const [later] = await db
      .select({ year: monthlyClientRecords.year, month: monthlyClientRecords.month })
      .from(monthlyClientRecords)
      .where(
        and(
          eq(monthlyClientRecords.billing_item_id, row.billing_item_id),
          sql`${monthlyClientRecords.year} * 12 + ${monthlyClientRecords.month} between ${rowIndex + 1} and ${rowIndex + months - 1}`
        )
      )
      .orderBy(asc(monthlyClientRecords.year), asc(monthlyClientRecords.month))
      .limit(1)
    if (later) {
      return Response.json(
        { error: `${later.year}年${later.month}月の行がすでにあるため、まとめられません。` },
        { status: 409 }
      )
    }

    const [data] = await db.update(monthlyClientRecords)
      .set({
        billing_amount_snapshot: parsed.data.total_amount,
        months_covered: months,
        label_snapshot: lumpLabel(item.label, row.year, row.month, months),
      })
      .where(eq(monthlyClientRecords.id, id))
      .returning()
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

// まとめを取り消し、1か月分の行に戻す。金額と内訳名は内訳マスタの今の値に戻す。
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/checklist/client-records/[id]/lump'>
) {
  try {
    const { id } = await ctx.params
    const [row] = await db.select().from(monthlyClientRecords).where(eq(monthlyClientRecords.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
    if (row.months_covered <= 1) return Response.json({ error: 'この行はまとめていません。' }, { status: 400 })
    // 送付済みの請求書はまとめた金額で出ているため、行だけ戻すと請求書と食い違う。
    if (row.invoice_sent_at) return Response.json({ error: '請求書を送付済みの行は取り消せません。' }, { status: 400 })

    const [item] = await db.select().from(clientBillingItems).where(eq(clientBillingItems.id, row.billing_item_id))
    if (!item) return Response.json({ error: '請求内訳が見つかりません。' }, { status: 404 })

    const [data] = await db.update(monthlyClientRecords)
      .set({
        months_covered: 1,
        billing_amount_snapshot: item.billing_amount,
        label_snapshot: item.label,
      })
      .where(eq(monthlyClientRecords.id, id))
      .returning()

    // 過去月の行でまとめていた場合、今月はまとめ行にカバーされて生成されていない。
    // 取り消した瞬間に今月の請求が消えたままにならないよう、今月分をここで作る。
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
