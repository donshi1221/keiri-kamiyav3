import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clientBillingItems, monthlyClientRecords } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { advancePlan, lumpLabel } from '@/lib/lump-sum'
import { parseBody, advanceBillingQuerySchema, advanceBillingCreateSchema } from '@/lib/validation'
import type { AdvanceBillingInfo } from '@/lib/ui-types'

// まとめ済みで行が無い月に、続きの月の分を請求する行（先取り行）を作る。
// 例: 9月の行で9・10月をまとめた内訳に、10月のうちに11・12月分を請求する。
// [id] ではなく内訳と年月で受けるのは、対象の月にはまだ行が無い（＝id が無い）ため。

// 内訳と、その内訳の月次行すべてを読んで「どの月から最大何か月請求できるか」を出す。
// 確認ダイアログの表示（GET）と実際の作成（POST）で同じ判定を使う。
async function loadPlan(billingItemId: string, year: number, month: number) {
  const [[item], rows] = await Promise.all([
    db.select().from(clientBillingItems).where(eq(clientBillingItems.id, billingItemId)),
    db
      .select({
        year: monthlyClientRecords.year,
        month: monthlyClientRecords.month,
        months_covered: monthlyClientRecords.months_covered,
        covers_from: monthlyClientRecords.covers_from,
      })
      .from(monthlyClientRecords)
      .where(eq(monthlyClientRecords.billing_item_id, billingItemId)),
  ])
  return { item, plan: advancePlan(item, rows, year, month) }
}

export async function GET(req: NextRequest) {
  try {
    const parsed = parseBody(advanceBillingQuerySchema, Object.fromEntries(req.nextUrl.searchParams))
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const { billing_item_id, year, month } = parsed.data

    const { item, plan } = await loadPlan(billing_item_id, year, month)
    if (!plan.ok) return Response.json({ error: plan.error }, { status: 400 })

    const info: AdvanceBillingInfo = { from: plan.from, maxMonths: plan.maxMonths, perMonthAmount: item.billing_amount }
    return Response.json(info)
  } catch (err) {
    return serverError(err)
  }
}

// 返り値はダッシュボードが行の一覧にそのまま足せる形（app/page.tsx の clientRecords と同じ関連付き）。
export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(advanceBillingCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const { billing_item_id, year, month, months, total_amount } = parsed.data

    const { item, plan } = await loadPlan(billing_item_id, year, month)
    if (!plan.ok) return Response.json({ error: plan.error }, { status: 400 })
    if (months > plan.maxMonths) {
      return Response.json({ error: `請求できるのは最大${plan.maxMonths}か月です。` }, { status: 400 })
    }

    // 同じ月・同じ内訳の行は一意制約で1つだけ。確認ダイアログを開いている間に別の操作で行ができていたら、
    // 何も作らずに 409 で知らせる（例外にして 500 にしない）。
    const [inserted] = await db.insert(monthlyClientRecords)
      .values({
        year,
        month,
        client_id: item.client_id,
        billing_item_id,
        billing_amount_snapshot: total_amount,
        months_covered: months,
        covers_from: `${plan.from.year}-${String(plan.from.month).padStart(2, '0')}-01`,
        label_snapshot: lumpLabel(item.label, plan.from.year, plan.from.month, months),
      })
      .onConflictDoNothing()
      .returning({ id: monthlyClientRecords.id })
    if (!inserted) {
      return Response.json({ error: 'この月にはすでに請求の行があります。画面を読み込み直してください。' }, { status: 409 })
    }

    const data = await db.query.monthlyClientRecords.findFirst({
      where: eq(monthlyClientRecords.id, inserted.id),
      with: {
        clients: { columns: { id: true, name: true } },
        billing_items: { columns: { id: true, label: true, billing_amount: true, one_time: true, contract_start: true, contract_months: true } },
      },
    })
    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
