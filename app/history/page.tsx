import { createAdminClient } from '@/lib/supabase'
import { nowJST } from '@/lib/dates'
import HistoryClient from './history-client'

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>
}) {
  const params = await searchParams
  const today = nowJST()
  const defaultDate = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const year = params.year ? Number(params.year) : defaultDate.getFullYear()
  const month = params.month ? Number(params.month) : defaultDate.getMonth() + 1

  const supabase = createAdminClient()

  const [
    { data: records },
    { data: clientRecords },
    { data: globalTask },
  ] = await Promise.all([
    supabase
      .from('monthly_records')
      .select('*, assignments ( *, contractors ( id, name, contractor_type ), clients ( id, name ) )')
      .eq('year', year)
      .eq('month', month)
      .order('created_at', { ascending: true }),
    supabase
      .from('monthly_client_records')
      .select('*, clients ( id, name, billing_amount )')
      .eq('year', year)
      .eq('month', month)
      .order('created_at', { ascending: true }),
    supabase
      .from('monthly_global_tasks')
      .select('*')
      .eq('year', year)
      .eq('month', month)
      .maybeSingle(),
  ])

  return (
    <HistoryClient
      year={year}
      month={month}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      records={(records ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientRecords={(clientRecords ?? []) as any}
      globalTask={globalTask ?? null}
    />
  )
}
