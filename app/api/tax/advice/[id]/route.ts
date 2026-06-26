import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/tax/advice/[id]'>
) {
  const { id } = await ctx.params
  const body = await req.json()
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('tax_advice_entries')
    .update({ title: body.title, body: body.body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data)
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/tax/advice/[id]'>
) {
  const { id } = await ctx.params
  const supabase = createAdminClient()
  const { error } = await supabase.from('tax_advice_entries').delete().eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return new Response(null, { status: 204 })
}
