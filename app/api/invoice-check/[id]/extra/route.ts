import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { assignments, expenses, invoiceUploads } from '@/lib/schema'
import { checkInvoiceAndSave, payoutMonthOf } from '@/lib/invoice-check'
import { keyedExtraItems } from '@/lib/invoice-extra'
import { parseBody, invoiceExtraActionSchema } from '@/lib/validation'

// 決定のあとに照合をやり直し、その中で編集者の納品シート（外部）を読みにいくことがある。
// recheck 側と同じ理由で既定より長い実行時間を許可する。
export const maxDuration = 60

// 請求書の追加費用（通常の作業分とは別の請求）を認める・認めないの操作。
//   approve  … 委託者へ払う経費（expenses の category='extra'）として登録する
//   reject   … 認めないと記録する（請求書はNGになり、返信の下書きが「修正のお願い」になる）
//   unreject … 「認めない」を取り消して未決定に戻す
// どれも記録したあとに照合をやり直すので、判定と返信の下書きはその場で新しくなる。
// 認めたものの取り消しはここには置かない。ダッシュボードの経費一覧から消せば、次の再チェックで未決定に戻る。
export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]/extra'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(invoiceExtraActionSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const input = parsed.data

    const [invoice] = await db
      .select({
        contractor_id: invoiceUploads.contractor_id,
        resolved_year: invoiceUploads.resolved_year,
        resolved_month: invoiceUploads.resolved_month,
        extracted_items: invoiceUploads.extracted_items,
        rejected_extras: invoiceUploads.rejected_extras,
      })
      .from(invoiceUploads)
      .where(eq(invoiceUploads.id, id))
    if (!invoice) return Response.json({ error: 'Not found' }, { status: 404 })

    // 画面が持っているキーが今の明細に実在するかを確かめる。再読み取りで明細が変わったあとに
    // 古い画面から押されると、存在しない明細に対して経費だけが登録されてしまうため。
    if (!keyedExtraItems(invoice.extracted_items ?? []).some((item) => item.key === input.key)) {
      return Response.json(
        { error: '対象の追加費用が見つかりません。画面を更新してからやり直してください。' },
        { status: 409 }
      )
    }
    if (!invoice.contractor_id || invoice.resolved_year === null || invoice.resolved_month === null) {
      return Response.json(
        { error: '委託者または対象月が特定できていないため、追加費用を決められません（先に修正・再チェックを行ってください）' },
        { status: 400 }
      )
    }

    // 経費は支払月（記載月の翌月）の行に登録する。照合本体と同じ換算を使う。
    const payout = payoutMonthOf(invoice.resolved_year, invoice.resolved_month)
    // 認め済みかどうかは請求書ではなく委託者×支払月で引く（照合本体と同じ。出し直された修正版でも
    // 同じ追加費用を二重に認めないため）。
    const [approved] = await db
      .select({ id: expenses.id })
      .from(expenses)
      .innerJoin(assignments, eq(expenses.assignment_id, assignments.id))
      .where(
        and(
          eq(assignments.contractor_id, invoice.contractor_id),
          eq(assignments.active, true),
          eq(expenses.year, payout.year),
          eq(expenses.month, payout.month),
          eq(expenses.category, 'extra'),
          eq(expenses.invoice_item_key, input.key)
        )
      )
      .limit(1)
    if (approved) {
      return Response.json(
        {
          error:
            input.action === 'approve'
              ? 'この追加費用はすでに認めています。画面を更新してください。'
              : 'この追加費用はすでに認めています。取り消すときは、ダッシュボードの経費一覧から削除してください。',
        },
        { status: 409 }
      )
    }

    const rejected = new Set(invoice.rejected_extras ?? [])
    if (input.action === 'approve') {
      const [assignment] = await db
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          and(
            eq(assignments.id, input.assignment_id),
            eq(assignments.contractor_id, invoice.contractor_id),
            eq(assignments.active, true)
          )
        )
      if (!assignment) {
        return Response.json({ error: 'この委託者のアサインではありません。選び直してください。' }, { status: 400 })
      }
      rejected.delete(input.key)
      // 経費の登録と「認めない」の取り下げは、片方だけ通ると「認めたのにNGのまま」になるため一括で行う
      // （neon-http は db.transaction が使えないので db.batch）。
      await db.batch([
        db.insert(expenses).values({
          assignment_id: assignment.id,
          year: payout.year,
          month: payout.month,
          amount: input.amount,
          note: input.note || null,
          category: 'extra',
          bill_client: input.bill_client,
          invoice_upload_id: id,
          invoice_item_key: input.key,
        }),
        db.update(invoiceUploads).set({ rejected_extras: [...rejected] }).where(eq(invoiceUploads.id, id)),
      ])
    } else {
      if (input.action === 'reject') rejected.add(input.key)
      else rejected.delete(input.key)
      await db.update(invoiceUploads).set({ rejected_extras: [...rejected] }).where(eq(invoiceUploads.id, id))
    }

    // 判定理由は保存済みの文字列を画面が読むだけなので、ここで照合をやり直さないと表示が変わらない。
    const outcome = await checkInvoiceAndSave(id, {
      trigger: input.action === 'approve' ? 'approve_extra' : 'reject_extra',
      origin: req.nextUrl.origin,
    })
    if (!outcome) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(outcome)
  } catch (err) {
    return serverError(err)
  }
}
