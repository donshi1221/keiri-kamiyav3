import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyRecords } from '@/lib/schema'
import { eq } from 'drizzle-orm'

const ALLOWED = ['invoice_received_at', 'contractor_paid_at'] as const
type ToggleField = typeof ALLOWED[number]

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/checklist/records/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()
    const field = body.field as string

    if (field === 'actual_payout_amount') {
      const value = body.value === '' ? null : Number(body.value)
      const [data] = await db.update(monthlyRecords)
        .set({ actual_payout_amount: isNaN(value as number) ? null : value })
        .where(eq(monthlyRecords.id, id))
        .returning()
      return Response.json(data)
    }

    if (!(ALLOWED as readonly string[]).includes(field)) {
      return Response.json({ error: 'Invalid field' }, { status: 400 })
    }

    const [current] = await db.select().from(monthlyRecords).where(eq(monthlyRecords.id, id))
    if (!current) return Response.json({ error: 'Not found' }, { status: 404 })

    const currentValue = current[field as ToggleField] as string | null
    const newValue = currentValue ? null : new Date().toISOString()

    const updateSet = field === 'invoice_received_at'
      ? { invoice_received_at: newValue }
      : { contractor_paid_at: newValue }

    const [data] = await db.update(monthlyRecords)
      .set(updateSet)
      .where(eq(monthlyRecords.id, id))
      .returning()

    return Response.json(data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
