import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'

export async function GET() {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('clients')
    .insert({
      name: body.name,
      contact_person: body.contact_person ?? null,
      billing_amount: body.billing_amount ?? 0,
      contract_start: body.contract_start ?? null,
      contract_months: body.contract_months ? Number(body.contract_months) : null,
      notes: body.notes ?? null,
    })
    .select()
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data, { status: 201 })
}
