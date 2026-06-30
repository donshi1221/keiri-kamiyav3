import { fetchMFExpenses } from '@/lib/moneyforward'
import { createAdminClient } from '@/lib/supabase'
import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
  const { year, month } = await req.json() as { year: number; month: number }

  if (!year || !month) {
    return Response.json({ error: 'year and month are required' }, { status: 400 })
  }

  try {
    const amount = await fetchMFExpenses(year, month)
    const supabase = createAdminClient()
    await supabase.from('moneyforward_expenses').upsert(
      { year, month, amount, synced_at: new Date().toISOString() },
      { onConflict: 'year,month' }
    )
    return Response.json({ ok: true, amount })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    if (message === 'MF_NOT_CONNECTED') {
      return Response.json({ error: 'not_connected' }, { status: 401 })
    }
    return Response.json({ error: message }, { status: 500 })
  }
}
