import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { nowJST } from '@/lib/dates'

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret')
  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = nowJST()
  const year = today.getFullYear()
  const month = today.getMonth() + 1
  const supabase = createAdminClient()

  const { data: assignments, error: assignErr } = await supabase
    .from('assignments')
    .select('id')
    .eq('active', true)

  if (assignErr) return Response.json({ error: assignErr.message }, { status: 500 })

  if (assignments && assignments.length > 0) {
    const { error } = await supabase
      .from('monthly_records')
      .upsert(
        assignments.map((a) => ({ year, month, assignment_id: a.id })),
        { onConflict: 'year,month,assignment_id', ignoreDuplicates: true }
      )
    if (error) return Response.json({ error: error.message }, { status: 500 })
  }

  const { data: clients, error: clientErr } = await supabase
    .from('clients')
    .select('id')

  if (clientErr) return Response.json({ error: clientErr.message }, { status: 500 })

  if (clients && clients.length > 0) {
    const { error } = await supabase
      .from('monthly_client_records')
      .upsert(
        clients.map((c) => ({ year, month, client_id: c.id })),
        { onConflict: 'year,month,client_id', ignoreDuplicates: true }
      )
    if (error) return Response.json({ error: error.message }, { status: 500 })
  }

  const { error: globalErr } = await supabase
    .from('monthly_global_tasks')
    .upsert({ year, month }, { onConflict: 'year,month', ignoreDuplicates: true })

  if (globalErr) return Response.json({ error: globalErr.message }, { status: 500 })

  return Response.json({ ok: true, year, month, assignmentCount: assignments?.length ?? 0 })
}
