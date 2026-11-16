import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { assignments, clientBillingItems, clientExpenses, expenses, monthlyClientRecords } from '@/lib/schema'
import { and, eq, exists, inArray, isNull, ne, not, notExists, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { parseBody, billingItemPatchSchema } from '@/lib/validation'
import { nowJST } from '@/lib/dates'
import { clientLumpRowCondition, isBillingItemActiveForMonth } from '@/lib/monthly-records'

// 更新後の契約期間の外になった請求行（monthly_client_records）を削除する。
// 消していいのは「生成されたまま、まだ誰も何も触っていない今月以降の行」だけ。
// 過去月は履歴なので残し、人が操作した行は期間外でも残す（消すと記録が消えて復元できない）。
// 考え方は委託者側の cleanupOutOfPeriodRecords（app/api/master/assignments/[id]）に揃えている。
async function cleanupOutOfPeriodClientRecords(itemId: string, today: Date) {
  const [item] = await db
    .select({
      contract_start: clientBillingItems.contract_start,
      contract_months: clientBillingItems.contract_months,
      active: clientBillingItems.active,
      billing_amount: clientBillingItems.billing_amount,
    })
    .from(clientBillingItems)
    .where(eq(clientBillingItems.id, itemId))

  // 非アクティブ化は既存の挙動（過去の記録を保全する）を変えないため掃除しない。
  if (!item || !item.active) return

  // 年月の比較は「年×12＋月」の通し番号にして、年またぎの場合分けを避ける。
  const currentIndex = today.getFullYear() * 12 + (today.getMonth() + 1)

  // 同じクライアント・同じ月の、この行以外の請求行。
  const otherRows = alias(monthlyClientRecords, 'other_client_records')

  const candidates = await db
    .select({ id: monthlyClientRecords.id, year: monthlyClientRecords.year, month: monthlyClientRecords.month })
    .from(monthlyClientRecords)
    .where(
      and(
        eq(monthlyClientRecords.billing_item_id, itemId),
        sql`${monthlyClientRecords.year} * 12 + ${monthlyClientRecords.month} >= ${currentIndex}`,
        isNull(monthlyClientRecords.invoice_sent_at),
        isNull(monthlyClientRecords.payment_confirmed_at),
        // 残りの月をまとめた行・続きの月を先に請求した行は人が操作して作った行なので、期間が変わっても消さない。
        not(clientLumpRowCondition!),
        // 「生成時のまま＝マスタの月額と一致」だけを未編集とみなし、手で直された行は残す。
        eq(monthlyClientRecords.billing_amount_snapshot, item.billing_amount),
        // 経費（自社経費・請求する立替経費）は請求行ではなくクライアント＋年月に紐づき、
        // 画面ではそのクライアントの請求行のグループの下に表示される。
        // その月のクライアントの請求行がこの行しか無いときに消すと、経費の表示先が無くなり請求漏れになるため、
        // 経費が付いている月は「触られている扱い」で残す。
        or(
          exists(
            db
              .select({ id: otherRows.id })
              .from(otherRows)
              .where(
                and(
                  eq(otherRows.client_id, monthlyClientRecords.client_id),
                  eq(otherRows.year, monthlyClientRecords.year),
                  eq(otherRows.month, monthlyClientRecords.month),
                  ne(otherRows.id, monthlyClientRecords.id)
                )
              )
          ),
          and(
            notExists(
              db
                .select({ id: clientExpenses.id })
                .from(clientExpenses)
                .where(
                  and(
                    eq(clientExpenses.client_id, monthlyClientRecords.client_id),
                    eq(clientExpenses.year, monthlyClientRecords.year),
                    eq(clientExpenses.month, monthlyClientRecords.month)
                  )
                )
            ),
            notExists(
              db
                .select({ id: expenses.id })
                .from(expenses)
                .innerJoin(assignments, eq(assignments.id, expenses.assignment_id))
                .where(
                  and(
                    eq(assignments.client_id, monthlyClientRecords.client_id),
                    eq(expenses.year, monthlyClientRecords.year),
                    eq(expenses.month, monthlyClientRecords.month),
                    eq(expenses.bill_client, true)
                  )
                )
            )
          )
        )
      )
    )

  const outOfPeriod = candidates.filter((r) => !isBillingItemActiveForMonth(item, r.year, r.month))
  if (outOfPeriod.length === 0) return

  await db.delete(monthlyClientRecords).where(inArray(monthlyClientRecords.id, outOfPeriod.map((r) => r.id)))
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/billing-items/[id]'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(billingItemPatchSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const v = parsed.data

    // 送られてきた項目だけを更新対象にする（未送信の項目を null / 0 で上書きしない）。
    const patch: Partial<typeof clientBillingItems.$inferInsert> = {}
    if (v.label !== undefined) patch.label = v.label?.trim() ?? ''
    if (v.billing_amount !== undefined) patch.billing_amount = v.billing_amount
    if (v.monthly_video_count !== undefined) patch.monthly_video_count = v.monthly_video_count
    if (v.one_time !== undefined) patch.one_time = v.one_time
    if (v.contract_start !== undefined) patch.contract_start = v.contract_start ?? null
    if (v.contract_months !== undefined) patch.contract_months = v.contract_months
    if (v.active !== undefined) patch.active = v.active
    if (v.sort_order !== undefined) patch.sort_order = v.sort_order

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    // 初回のみ（初期費用）かどうかは、今回の送信内容だけでは判定できない。
    // 例えば one_time を送らずに契約期間だけ更新されると、既存の初期費用が毎月請求に化けてしまう。
    // 未送信の項目は既存行の値を使って判定する。
    const [current] = await db.select().from(clientBillingItems).where(eq(clientBillingItems.id, id))
    if (!current) return Response.json({ error: 'Not found' }, { status: 404 })

    const oneTime = v.one_time ?? current.one_time
    if (oneTime) {
      const contractStart = v.contract_start !== undefined ? (v.contract_start ?? null) : current.contract_start
      // 請求月が無いと毎月請求が立ち続けるため、初期費用としては保存させない。
      if (!contractStart) {
        return Response.json({ error: '初回のみの内訳には請求月が必要です。' }, { status: 400 })
      }
      // 初回のみ＝請求月の1ヶ月だけ有効。動画の本数も持たない。
      patch.contract_months = 1
      patch.monthly_video_count = 0
    }

    const [data] = await db.update(clientBillingItems).set(patch).where(eq(clientBillingItems.id, id)).returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })

    // 月額を変えたときは、生成済みの月次記録の控えも今月以降のぶんだけ追従させる。
    // 過去月と請求書送付済みの月は、確定した数字を遡って変えないため対象外にする。
    // 残りの月をまとめた行・続きの月を先に請求した行は、人が決めた合計額なので月額で上書きしない。
    if (v.billing_amount !== undefined) {
      const now = nowJST()
      const cutoff = now.getFullYear() * 100 + (now.getMonth() + 1)
      await db
        .update(monthlyClientRecords)
        .set({ billing_amount_snapshot: v.billing_amount })
        .where(
          and(
            eq(monthlyClientRecords.billing_item_id, id),
            isNull(monthlyClientRecords.invoice_sent_at),
            not(clientLumpRowCondition!),
            sql`${monthlyClientRecords.year} * 100 + ${monthlyClientRecords.month} >= ${cutoff}`
          )
        )
    }

    // 契約期間を短くした後に、期間外になった請求行を掃除する。
    // 生成（追加専用）だけでは、月初の自動生成で作られた行が期間外になっても残り続け、
    // 契約が終わったクライアントに請求が立ったままになるため。
    // 期間に関わる項目を送ったときだけ走らせる（名前や並び順の保存で行が消えることが無いように）。
    // 掃除が失敗してもマスタの保存自体は成功させたいので、ここだけ個別に握る（ログには必ず残す）。
    if (v.contract_start !== undefined || v.contract_months !== undefined || v.one_time !== undefined) {
      try {
        await cleanupOutOfPeriodClientRecords(id, nowJST())
      } catch (cleanupErr) {
        console.error('[master/billing-items] cleanup out-of-period client records failed:', cleanupErr)
      }
    }

    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/billing-items/[id]'>
) {
  try {
    const { id } = await ctx.params

    // 月次記録が内訳を参照しているとDBの外部キー制約で生の500になる。事前に件数で弾く。
    // 過去の記録を残したい場合は、削除ではなく「非アクティブ化」で今後の生成だけ止める運用にする。
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(monthlyClientRecords)
      .where(eq(monthlyClientRecords.billing_item_id, id))

    if (Number(count) > 0) {
      return Response.json(
        { error: `${count}件の月次記録が存在するため削除できません。`, hint: 'inactive' },
        { status: 409 }
      )
    }

    await db.delete(clientBillingItems).where(eq(clientBillingItems.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err)
  }
}
