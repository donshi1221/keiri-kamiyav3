import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyClientRecords } from '@/lib/schema'
import { eq } from 'drizzle-orm'

const ALLOWED = ['invoice_sent_at', 'payment_confirmed_at'] as const
type ToggleField = typeof ALLOWED[number]

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/checklist/client-records/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()
    const field = body.field as string

    if (!(ALLOWED as readonly string[]).includes(field)) {
      return Response.json({ error: 'Invalid field' }, { status: 400 })
    }

    const [current] = await db.select().from(monthlyClientRecords).where(eq(monthlyClientRecords.id, id))
    if (!current) return Response.json({ error: 'Not found' }, { status: 404 })

    const currentValue = current[field as ToggleField] as string | null
    const newValue = currentValue ? null : new Date().toISOString()

    const updateSet = field === 'invoice_sent_at'
      ? { invoice_sent_at: newValue }
      : { payment_confirmed_at: newValue }

    const [data] = await db.update(monthlyClientRecords)
      .set(updateSet)
      .where(eq(monthlyClientRecords.id, id))
      .returning()

    return Response.json(data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
