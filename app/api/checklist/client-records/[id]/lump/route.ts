import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clientBillingItems, monthlyClientRecords } from '@/lib/schema'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { clientLaterRowBlockCause, clientLumpBlockReason, coverRange, laterRowBlockMessage, laterRowsInRange, lumpLabel, monthIndex, remainingMonths, resolveLumpMonths } from '@/lib/lump-sum'
import { parseBody, lumpSumCreateSchema } from '@/lib/validation'
import type { MonthlyClientRecord } from '@/lib/schema'
import type { LumpLaterRow } from '@/lib/ui-types'

// 行の翌月〜契約の最後の月にすでにある同じ内訳の行を、まとめに取り込めるかどうか付きで読む。
// 確認ダイアログの事前表示（GET）と、実際にまとめるとき（POST）で同じ判定を使う。
async function loadLaterRows(row: MonthlyClientRecord, remaining: number): Promise<(LumpLaterRow & { id: string })[]> {
  const rowIndex = monthIndex(row.year, row.month)
  const rows = await db
    .select()
    .from(monthlyClientRecords)
    .where(
      and(
        eq(monthlyClientRecords.billing_item_id, row.billing_item_id),
        sql`${monthlyClientRecords.year} * 12 + ${monthlyClientRecords.month} between ${rowIndex + 1} and ${rowIndex + remaining - 1}`
      )
    )
    .orderBy(asc(monthlyClientRecords.year), asc(monthlyClientRecords.month))
  return rows.map((r) => {
    const cause = clientLaterRowBlockCause(r)
    return {
      id: r.id,
      year: r.year,
      month: r.month,
      amount: r.billing_amount_snapshot,
      absorbable: cause === null,
      reason: cause === null ? null : laterRowBlockMessage(r.year, r.month, cause),
    }
  })
}

// 確認ダイアログ用。まとめる月数を選ぶ前に「どの月の行が取り込まれるか／どの月数は選べないか」を
// 画面で見せるため、後ろの月の既存行を返す（サーバーに断られるまで分からない状態を避ける）。
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/checklist/client-records/[id]/lump'>
) {
  try {
    const { id } = await ctx.params
    const [row] = await db.select().from(monthlyClientRecords).where(eq(monthlyClientRecords.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
    const [item] = await db.select().from(clientBillingItems).where(eq(clientBillingItems.id, row.billing_item_id))

    const reason = clientLumpBlockReason(row, item)
    if (reason) return Response.json({ error: reason }, { status: 400 })
    const remaining = remainingMonths(row, item.contract_start, item.contract_months)!

    const laterRows: LumpLaterRow[] = (await loadLaterRows(row, remaining)).map(({ id: _id, ...rest }) => rest)
    return Response.json({ laterRows })
  } catch (err) {
    return serverError(err)
  }
}

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
    const remaining = remainingMonths(row, item.contract_start, item.contract_months)!
    const resolved = resolveLumpMonths(remaining, parsed.data.months)
    if (!resolved.ok) return Response.json({ error: resolved.error }, { status: 400 })
    const months = resolved.months

    // まとめる範囲の月にすでに行があると、その月の分を二重に請求することになる。
    // 月初の自動生成でできただけの手つかずの行は、まとめに取り込んで消す。
    // 送付・入金の記録が付いた行は消すと記録が失われるので、1つでもあれば何も変えずに断る。
    const inRange = laterRowsInRange(await loadLaterRows(row, remaining), row.year, row.month, months)
    const blocked = inRange.find((r) => !r.absorbable)
    if (blocked) return Response.json({ error: blocked.reason }, { status: 409 })

    const update = db.update(monthlyClientRecords)
      .set({
        billing_amount_snapshot: parsed.data.total_amount,
        months_covered: months,
        label_snapshot: lumpLabel(item.label, row.year, row.month, months),
      })
      .where(eq(monthlyClientRecords.id, id))
      .returning()

    if (inRange.length === 0) {
      const [data] = await update
      return Response.json(data)
    }

    // 取り込む行の削除とまとめの更新は、片方だけ成功すると「行は消えたのにまとめていない」
    // 「まとめたのに後ろの月の行が残って二重請求」になる。neon-http は対話的なトランザクション
    // （db.transaction）が使えないが、db.batch は1回の通信で全部成功か全部失敗かになるためこれを使う。
    // where に手つかずの条件を重ねているのは、判定から削除までの間に人が付けた記録を消さないための二重の歯止め。
    const [, [data]] = await db.batch([
      db.delete(monthlyClientRecords).where(
        and(
          inArray(monthlyClientRecords.id, inRange.map((r) => r.id)),
          isNull(monthlyClientRecords.invoice_sent_at),
          isNull(monthlyClientRecords.payment_confirmed_at),
          eq(monthlyClientRecords.months_covered, 1),
          isNull(monthlyClientRecords.covers_from)
        )
      ),
      update,
    ])
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

// まとめを取り消し、1か月分の行に戻す。金額と内訳名は内訳マスタの今の値に戻す。
// 続きの月を先に請求した行（先取り行。covers_from あり）は、その月に本来は行が無いので行ごと消す。
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/checklist/client-records/[id]/lump'>
) {
  try {
    const { id } = await ctx.params
    const [row] = await db.select().from(monthlyClientRecords).where(eq(monthlyClientRecords.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    const today = nowJST()
    const currentIndex = monthIndex(today.getFullYear(), today.getMonth() + 1)
    const range = coverRange(row)

    if (row.covers_from) {
      if (row.invoice_sent_at || row.payment_confirmed_at) {
        return Response.json({ error: '請求書を送付済み・入金確認済みの行は取り消せません。' }, { status: 400 })
      }
      // where に条件を重ねているのは、判定から削除までの間に付いた送付・入金の記録を消さないため。
      const deleted = await db.delete(monthlyClientRecords)
        .where(
          and(
            eq(monthlyClientRecords.id, id),
            isNull(monthlyClientRecords.invoice_sent_at),
            isNull(monthlyClientRecords.payment_confirmed_at)
          )
        )
        .returning({ id: monthlyClientRecords.id })
      if (deleted.length === 0) {
        return Response.json({ error: '請求書を送付済み・入金確認済みの行は取り消せません。' }, { status: 409 })
      }
      // この行がまかなっていた月に今月が含まれるなら、今月の行は作られていない。消した瞬間に
      // 今月の請求が無いままにならないよう、今月分をここで作る。
      if (range.from <= currentIndex && currentIndex <= range.to) {
        await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)
      }
      // 行そのものが無くなったことを画面へ伝える（まとめの取り消しは更新後の行を返すので、形で区別できるようにする）。
      return Response.json({ deleted: true, id })
    }

    if (row.months_covered <= 1) return Response.json({ error: 'この行はまとめていません。' }, { status: 400 })
    // 送付済みの請求書はまとめた金額で出ているため、行だけ戻すと請求書と食い違う。
    if (row.invoice_sent_at) return Response.json({ error: '請求書を送付済みの行は取り消せません。' }, { status: 400 })

    // まとめ済みの月に「続きの月の請求」の行が立っていると、まとめを外した時点でその月に
    // 通常の行を作れなくなる（同じ月に行は1つ）うえ、どの月の分の請求かが読めなくなる。先にそちらを取り消してもらう。
    const [advance] = await db
      .select({ year: monthlyClientRecords.year, month: monthlyClientRecords.month })
      .from(monthlyClientRecords)
      .where(
        and(
          eq(monthlyClientRecords.billing_item_id, row.billing_item_id),
          sql`${monthlyClientRecords.year} * 12 + ${monthlyClientRecords.month} between ${range.from + 1} and ${range.to}`
        )
      )
      .orderBy(asc(monthlyClientRecords.year), asc(monthlyClientRecords.month))
      .limit(1)
    if (advance) {
      return Response.json(
        { error: `${advance.year}年${advance.month}月の行（続きの月の請求）を先に取り消してください。` },
        { status: 409 }
      )
    }

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
    if (range.from < currentIndex && currentIndex <= range.to) {
      await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)
    }

    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}
