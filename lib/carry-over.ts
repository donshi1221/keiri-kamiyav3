import { formatInTimeZone } from 'date-fns-tz'
import { TZ } from './dates'

export interface CarryOverGroup {
  year: number
  month: number
  items: { label: string; count: number }[]
}

interface PastRecord {
  year: number
  month: number
  invoice_received_at: string | null
  payment_reserved_at: string | null
  contractor_paid_at: string | null
}

interface PastClientRecord {
  year: number
  month: number
  invoice_sent_at: string | null
  payment_confirmed_at: string | null
}

interface PastGlobalTask {
  year: number
  month: number
  expense_confirmed_at: string | null
  payment_report_confirmed_at: string | null
  withholding_confirmed_at: string | null
}

interface PastCustomTask {
  title: string
  months: number[]
  completed_months: number[]
  created_at: string
}

export function computeCarryOver(
  records: PastRecord[],
  clientRecords: PastClientRecord[],
  currentYear: number,
  currentMonth: number,
  globalTasks: PastGlobalTask[] = [],
  customTasks: PastCustomTask[] = []
): CarryOverGroup[] {
  const currentYM = currentYear * 12 + currentMonth
  const groups = new Map<string, Map<string, number>>()

  function bump(year: number, month: number, label: string) {
    if (year * 12 + month >= currentYM) return
    const key = `${year}-${month}`
    if (!groups.has(key)) groups.set(key, new Map())
    const counts = groups.get(key)!
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  for (const r of records) {
    if (!r.invoice_received_at) bump(r.year, r.month, '請求書受領')
    if (!r.payment_reserved_at) bump(r.year, r.month, '支払い予約')
    if (!r.contractor_paid_at) bump(r.year, r.month, '支払い確認')
  }
  for (const r of clientRecords) {
    if (!r.invoice_sent_at) bump(r.year, r.month, '請求書送付')
    if (!r.payment_confirmed_at) bump(r.year, r.month, '入金確認')
  }
  // ラベルはダッシュボードの globalTaskDefs と同一文言にする（同じタスクが別名で出ると混乱するため）。
  for (const g of globalTasks) {
    if (!g.expense_confirmed_at) bump(g.year, g.month, '社長経費確認')
    if (!g.payment_report_confirmed_at) bump(g.year, g.month, '支払・報酬 請求書チェック出し')
    if (!g.withholding_confirmed_at) bump(g.year, g.month, '源泉所得税確認')
  }

  // カスタムタスクは月ごとの行を持たないため、そのままでは何月まで遡るべきか決まらない。
  // グローバルタスクの行がある月＝アプリで運用していた月とみなし、その範囲だけを対象にする。
  for (const g of globalTasks) {
    const yearMonth = g.year * 100 + g.month
    for (const t of customTasks) {
      if (t.months.length > 0 && !t.months.includes(g.month)) continue
      // 作成前の月まで遡って未完了扱いにしない。
      const createdYearMonth = Number(formatInTimeZone(new Date(t.created_at), TZ, 'yyyyMM'))
      if (createdYearMonth > yearMonth) continue
      if (t.completed_months.includes(yearMonth)) continue
      bump(g.year, g.month, t.title)
    }
  }

  return Array.from(groups.entries())
    .map(([key, counts]) => {
      const [year, month] = key.split('-').map(Number)
      return {
        year,
        month,
        items: Array.from(counts.entries()).map(([label, count]) => ({ label, count })),
      }
    })
    .sort((a, b) => (b.year * 12 + b.month) - (a.year * 12 + a.month))
}
