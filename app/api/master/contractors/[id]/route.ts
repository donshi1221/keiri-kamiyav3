import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/contractors/[id]'>
) {
  const { id } = await ctx.params
  const body = await req.json()
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('contractors')
    .update({
      name: body.name,
      contractor_type: body.contractor_type,
      email: body.email ?? null,
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
  ctx: RouteContext<'/api/master/contractors/[id]'>
) {
  const { id } = await ctx.params
  const supabase = createAdminClient()
  const { error } = await supabase.from('contractors').delete().eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return new Response(null, { status: 204 })
}
