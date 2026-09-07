import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { assignments, expenses, monthlyRecords } from '@/lib/schema'
import { and, eq, inArray, isNull, notExists, or, sql } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords, isPaymentActiveForMonth } from '@/lib/monthly-records'

// 更新後の支払期間の外になった月次レコードを削除する。
// 消していいのは「生成されたまま、まだ誰も何も触っていない今月以降の行」だけ。
// 過去月は履歴なので残し、人やシステムが値を入れた行は期間外でも残す（消すと記録が消えて復元できない）。
async function cleanupOutOfPeriodRecords(assignmentId: string, today: Date) {
  const [assignment] = await db
    .select({
      payment_start_month: assignments.payment_start_month,
      payment_count: assignments.payment_count,
      active: assignments.active,
      contractor_payout_amount: assignments.contractor_payout_amount,
    })
    .from(assignments)
    .where(eq(assignments.id, assignmentId))

  // 非アクティブ化は既存の挙動（過去の記録を保全する）を変えないため掃除しない。
  if (!assignment || !assignment.active) return

  // 年月の比較は「年×12＋月」の通し番号にして、年またぎの場合分けを避ける。
  const currentIndex = today.getFullYear() * 12 + (today.getMonth() + 1)

  const candidates = await db
    .select({ id: monthlyRecords.id, year: monthlyRecords.year, month: monthlyRecords.month })
    .from(monthlyRecords)
    .where(
      and(
        eq(monthlyRecords.assignment_id, assignmentId),
        sql`${monthlyRecords.year} * 12 + ${monthlyRecords.month} >= ${currentIndex}`,
        isNull(monthlyRecords.actual_payout_amount),
        isNull(monthlyRecords.delivered_video_count),
        isNull(monthlyRecords.invoice_received_at),
        isNull(monthlyRecords.payment_reserved_at),
        isNull(monthlyRecords.contractor_paid_at),
        // payout_amount_snapshot は生成時にマスタの契約額が入るため NULL 判定ができない。
        // 「生成時のまま＝マスタの契約額と一致」だけを未編集とみなし、手で直された行は残す。
        or(
          isNull(monthlyRecords.payout_amount_snapshot),
          eq(monthlyRecords.payout_amount_snapshot, assignment.contractor_payout_amount)
        ),
        // 経費（expenses）は月次レコードではなくアサイン＋年月に紐づくため、
        // 月次レコードだけ消すと経費が宙に浮く。経費が付いている月は「触られている扱い」で残す。
        notExists(
          db
            .select({ id: expenses.id })
            .from(expenses)
            .where(
              and(
                eq(expenses.assignment_id, monthlyRecords.assignment_id),
                eq(expenses.year, monthlyRecords.year),
                eq(expenses.month, monthlyRecords.month)
              )
            )
        )
      )
    )

  const outOfPeriod = candidates.filter((r) => !isPaymentActiveForMonth(assignment, r.year, r.month))
  if (outOfPeriod.length === 0) return

  await db.delete(monthlyRecords).where(inArray(monthlyRecords.id, outOfPeriod.map((r) => r.id)))
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/assignments/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()

    if (body.contractor_id !== undefined || body.client_id !== undefined) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(monthlyRecords)
        .where(eq(monthlyRecords.assignment_id, id))

      if (Number(count) > 0) {
        return Response.json(
          { error: '月次記録が存在するため、委託者・クライアントの変更はできません。' },
          { status: 409 }
        )
      }
    }

    // リクエストに含まれた項目だけを更新対象にする（undefined のキーは触らない）。
    // これをしないと、UIが一部の項目だけ送った場合に未送信の項目が null 上書きで消える。
    const patch: Partial<typeof assignments.$inferInsert> = {}
    if (body.contractor_id !== undefined) patch.contractor_id = body.contractor_id
    if (body.client_id !== undefined) patch.client_id = body.client_id
    if (body.role_name !== undefined) patch.role_name = body.role_name
    if (body.contractor_payout_amount !== undefined) patch.contractor_payout_amount = body.contractor_payout_amount
    if (body.payment_start_month !== undefined) patch.payment_start_month = body.payment_start_month ? `${body.payment_start_month}-01` : null
    if (body.payment_count !== undefined) patch.payment_count = body.payment_count
    if (body.spreadsheet_url !== undefined) patch.spreadsheet_url = body.spreadsheet_url
    if (body.active !== undefined) patch.active = body.active

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    await db.update(assignments).set(patch).where(eq(assignments.id, id))

    // 開始月・回数の編集後も、表示中の月に該当する月次レコードを自動生成する。
    const today = nowJST()
    await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)

    // 支払期間を短くした後に、期間外になった月次レコードを掃除する。
    // 生成（追加専用）だけでは、月初の自動生成で作られた行が期間外になっても残り続け、
    // 請求書チェックの支払予定額に混入してしまうため。
    // 掃除が失敗してもマスタの保存自体は成功させたいので、ここだけ個別に握る（ログには必ず残す）。
    try {
      await cleanupOutOfPeriodRecords(id, today)
    } catch (cleanupErr) {
      console.error('[master/assignments] cleanup out-of-period monthly records failed:', cleanupErr)
    }

    const data = await db.query.assignments.findFirst({
      where: (a, { eq: eqFn }) => eqFn(a.id, id),
      with: {
        contractors: { columns: { id: true, name: true, contractor_type: true } },
        clients: { columns: { id: true, name: true } },
      },
    })
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/assignments/[id]'>
) {
  try {
    const { id } = await ctx.params

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(monthlyRecords)
      .where(eq(monthlyRecords.assignment_id, id))

    if (Number(count) > 0) {
      return Response.json(
        { error: `${count}件の月次記録が存在します。`, hint: 'inactive' },
        { status: 409 }
      )
    }

    await db.delete(assignments).where(eq(assignments.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err)
  }
}
