import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/clients/[id]'>
) {
  const { id } = await ctx.params
  const body = await req.json()
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('clients')
    .update({
      name: body.name,
      contact_person: body.contact_person ?? null,
      billing_amount: body.billing_amount ?? 0,
      contract_start: body.contract_start ?? null,
      contract_months: body.contract_months ? Number(body.contract_months) : null,
      notes: body.notes ?? null,
    })
    .eq('id', id)
    .select()
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data)
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/clients/[id]'>
) {
  const { id } = await ctx.params
  const supabase = createAdminClient()
  const { error } = await supabase.from('clients').delete().eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return new Response(null, { status: 204 })
}
