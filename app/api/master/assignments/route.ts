import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'

export async function GET() {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('assignments')
    .select('*, contractors ( id, name, contractor_type ), clients ( id, name )')
    .order('created_at', { ascending: true })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('assignments')
    .insert({
      contractor_id: body.contractor_id,
      client_id: body.client_id,
      role_name: body.role_name ?? '撮影+台本',
      contractor_payout_amount: body.contractor_payout_amount ?? 0,
      spreadsheet_url: body.spreadsheet_url ?? null,
      active: body.active ?? true,
    })
    .select('*, contractors ( id, name, contractor_type ), clients ( id, name )')
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data, { status: 201 })
}
