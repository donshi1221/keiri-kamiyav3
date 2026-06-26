import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'

const ALLOWED = ['invoice_received_at', 'contractor_paid_at'] as const
type ToggleField = typeof ALLOWED[number]

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/checklist/records/[id]'>
) {
  const { id } = await ctx.params
  const body = await req.json()
  const field = body.field as string

  if (field === 'actual_payout_amount') {
    const value = body.value === '' ? null : Number(body.value)
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('monthly_records')
      .update({ actual_payout_amount: isNaN(value as number) ? null : value })
      .eq('id', id)
      .select()
      .single()
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json(data)
  }

  if (!(ALLOWED as readonly string[]).includes(field)) {
    return Response.json({ error: 'Invalid field' }, { status: 400 })
  }

  const supabase = createAdminClient()
  const { data: current, error: fetchErr } = await supabase
    .from('monthly_records')
    .select(field as ToggleField)
    .eq('id', id)
    .single()

  if (fetchErr) return Response.json({ error: fetchErr.message }, { status: 500 })

  const newValue = (current as Record<string, string | null>)[field] ? null : new Date().toISOString()

  const { data, error } = await supabase
    .from('monthly_records')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ [field]: newValue } as any)
    .eq('id', id)
    .select()
    .single()

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data)
}
