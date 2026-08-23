import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { payrollRecipients, payrollRecurringReimbursements } from '@/lib/schema'
import { asc, eq } from 'drizzle-orm'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { parseBody, recurringReimbursementCreateSchema } from '@/lib/validation'

// 毎月の定額立替のマスタ一覧。停止中（active=false）も含めて全件返す。
// 一覧から消してしまうと「止めたつもりが登録ごと消えたのか、止まっているだけなのか」が
// 画面から判断できず、再開の操作にもたどり着けなくなるため。
// 並びは対象者ごとにまとめたいので、対象者名 → 登録順にする。
export async function GET() {
  try {
    const rows = await db
      .select({
        recurring: payrollRecurringReimbursements,
        recipient: {
          id: payrollRecipients.id,
          name: payrollRecipients.name,
          kind: payrollRecipients.kind,
          active: payrollRecipients.active,
        },
      })
      .from(payrollRecurringReimbursements)
      .innerJoin(payrollRecipients, eq(payrollRecurringReimbursements.recipient_id, payrollRecipients.id))
      .orderBy(asc(payrollRecipients.name), asc(payrollRecurringReimbursements.created_at))

    // 画面（lib/ui-types の RecurringReimbursementWithRecipient）が扱う形に寄せる。
    const data = rows.map((r) => ({ ...r.recurring, payroll_recipients: r.recipient }))
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(recurringReimbursementCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data

    const [data] = await db.insert(payrollRecurringReimbursements).values({
      recipient_id: body.recipient_id,
      description: body.description,
      amount: body.amount,
      start_year: body.start_year,
      start_month: body.start_month,
      active: body.active ?? true,
    }).returning()

    // 登録した定額立替が当月のダッシュボードにすぐ並ぶようにする（対象者マスタの追加と同じ作法）。
    // 生成は冪等（(recurring_id, year, month) の一意制約 + onConflictDoNothing）なので、
    // 毎月1日のcronと二重に走っても行は増えない。
    const today = nowJST()
    await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)

    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
