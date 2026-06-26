import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/assignments/[id]'>
) {
  const { id } = await ctx.params
  const body = await req.json()
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('assignments')
    .update({
      contractor_id: body.contractor_id,
      client_id: body.client_id,
      role_name: body.role_name,
      contractor_payout_amount: body.contractor_payout_amount,
      spreadsheet_url: body.spreadsheet_url ?? null,
      active: body.active,
    })
    .eq('id', id)
    .select('*, contractors ( id, name, contractor_type ), clients ( id, name )')
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data)
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/assignments/[id]'>
) {
  const { id } = await ctx.params
  const supabase = createAdminClient()

  const { count } = await supabase
    .from('monthly_records')
    .select('*', { count: 'exact', head: true })
    .eq('assignment_id', id)

  if (count && count > 0) {
    return Response.json(
      { error: `${count}件の月次記録が存在します。`, hint: 'inactive' },
      { status: 409 }
    )
  }

  const { error } = await supabase.from('assignments').delete().eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return new Response(null, { status: 204 })
}
