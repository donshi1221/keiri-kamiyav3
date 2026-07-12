import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyGlobalTasks } from '@/lib/schema'
import { eq } from 'drizzle-orm'

const ALLOWED = ['expense_confirmed_at', 'payment_report_confirmed_at', 'withholding_confirmed_at'] as const
type ToggleField = typeof ALLOWED[number]

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/checklist/global/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()
    const field = body.field as string

    if (!(ALLOWED as readonly string[]).includes(field)) {
      return Response.json({ error: 'Invalid field' }, { status: 400 })
    }
    // 冪等化: クライアントが「したい状態」を checked で明示的に送る（トグルしない）。
    if (typeof body.checked !== 'boolean') {
      return Response.json({ error: 'checked (boolean) is required' }, { status: 400 })
    }

    const [current] = await db.select().from(monthlyGlobalTasks).where(eq(monthlyGlobalTasks.id, id))
    if (!current) return Response.json({ error: 'Not found' }, { status: 404 })

    // 既にチェック済みで再度 checked=true が来た場合は、最初のチェック日時を保持する。
    const existing = current[field as ToggleField] as string | null
    const newValue = body.checked ? (existing ?? new Date().toISOString()) : null

    let updateSet: Partial<typeof monthlyGlobalTasks.$inferInsert>
    if (field === 'expense_confirmed_at') updateSet = { expense_confirmed_at: newValue }
    else if (field === 'payment_report_confirmed_at') updateSet = { payment_report_confirmed_at: newValue }
    else updateSet = { withholding_confirmed_at: newValue }

    const [data] = await db.update(monthlyGlobalTasks)
      .set(updateSet)
      .where(eq(monthlyGlobalTasks.id, id))
      .returning()

    return Response.json(data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
