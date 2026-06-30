import { createAdminClient } from '@/lib/supabase'
import { nowJST } from '@/lib/dates'
import DashboardClient from './components/dashboard-client'
import type { CustomGlobalTask } from '@/lib/database.types'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>
}) {
  const params = await searchParams
  const today = nowJST()
  const year = params.year ? Number(params.year) : today.getFullYear()
  const month = params.month ? Number(params.month) : today.getMonth() + 1

  const supabase = createAdminClient()

  const [
    { data: records },
    { data: clientRecords },
    { data: globalTask },
    { data: clients },
    { data: allCustomTasks },
    { data: mfExpense },
    { data: mfToken },
  ] = await Promise.all([
    supabase
      .from('monthly_records')
      .select('*, assignments ( *, contractors ( id, name, contractor_type ), clients ( id, name ) )')
      .eq('year', year)
      .eq('month', month)
      .order('created_at', { ascending: true }),
    supabase
      .from('monthly_client_records')
      .select('*, clients ( id, name, billing_amount, contract_start, contract_months )')
      .eq('year', year)
      .eq('month', month)
      .order('created_at', { ascending: true }),
    supabase
      .from('monthly_global_tasks')
      .select('*')
      .eq('year', year)
      .eq('month', month)
      .maybeSingle(),
    supabase
      .from('monthly_client_records')
      .select('client_id, invoice_sent_at')
      .not('invoice_sent_at', 'is', null),
    supabase
      .from('monthly_custom_global_tasks')
      .select('*')
      .order('created_at', { ascending: true }),
    supabase
      .from('moneyforward_expenses')
      .select('amount, synced_at')
      .eq('year', year)
      .eq('month', month)
      .maybeSingle(),
    supabase
      .from('moneyforward_tokens')
      .select('updated_at')
      .limit(1)
      .maybeSingle(),
  ])

  const customTasks: CustomGlobalTask[] = ((allCustomTasks ?? []) as CustomGlobalTask[]).filter(
    (t) => t.months.length === 0 || t.months.includes(month)
  )

  const billedCounts: Record<string, number> = {}
  const paidCounts: Record<string, number> = {}

  const { data: allClientRecords } = await supabase
    .from('monthly_client_records')
    .select('client_id, invoice_sent_at, payment_confirmed_at')

  for (const r of allClientRecords ?? []) {
    if (r.invoice_sent_at) billedCounts[r.client_id] = (billedCounts[r.client_id] ?? 0) + 1
    if (r.payment_confirmed_at) paidCounts[r.client_id] = (paidCounts[r.client_id] ?? 0) + 1
  }

  return (
    <DashboardClient
      year={year}
      month={month}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      records={(records ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientRecords={(clientRecords ?? []) as any}
      globalTask={globalTask ?? null}
      customTasks={customTasks}
      today={today.toISOString()}
      billedCounts={billedCounts}
      paidCounts={paidCounts}
      mfExpense={mfExpense ? { amount: mfExpense.amount, syncedAt: mfExpense.synced_at } : null}
      mfConnected={!!mfToken}
    />
  )
}
