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

export function computeCarryOver(
  records: PastRecord[],
  clientRecords: PastClientRecord[],
  currentYear: number,
  currentMonth: number
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
