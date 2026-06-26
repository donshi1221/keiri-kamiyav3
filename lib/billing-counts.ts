import 'server-only'
import { createAdminClient } from './supabase'

export async function getBilledCountByClient(clientId: string): Promise<number> {
  const supabase = createAdminClient()
  const { count } = await supabase
    .from('monthly_client_records')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .not('invoice_sent_at', 'is', null)
  return count ?? 0
}

export async function getPaidCountByClient(clientId: string): Promise<number> {
  const supabase = createAdminClient()
  const { count } = await supabase
    .from('monthly_client_records')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .not('payment_confirmed_at', 'is', null)
  return count ?? 0
}
