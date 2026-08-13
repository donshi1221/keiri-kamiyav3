import type { ExpenseItemKind } from '@/lib/ui-types'

// 経費の明細を「代表が割り当てる受付ページ」と「経理が確認する画面」の両方で同じ見た目にするための表示処理。
// 片方だけ言い回しや書式を変えると、同じ1行が画面ごとに別物に見えて確認の突き合わせができなくなるため、
// 表示の決まりごとはここ1か所に置く（選択肢そのものの正本は lib/config）。

// 区分の表示名。値（client_billed など）は英語のままDBに入るので、人が読む名前を対応付ける。
export const EXPENSE_KIND_LABEL: Record<ExpenseItemKind, string> = {
  client_billed: 'クライアントに請求',
  company: '自社経費',
  excluded: '対象外',
}

// 利用日は date 列（'2026-07-30' の文字列）。Date に変換すると閲覧端末のタイムゾーン分だけ
// 前日にずれることがあるため、文字列のまま切り出して組み立てる。
export function formatExpenseDate(date: string | null): string {
  if (!date) return '日付なし'
  const [, month, day] = date.split('-')
  return month && day ? `${Number(month)}/${Number(day)}` : date
}

// 区間は領収書のように「そもそも区間が無い」書類だと両方 null になる。
// 片方だけ読めた場合も原本と突き合わせられるよう、読めなかった側は — で埋めて形を残す。
export function formatExpenseRoute(from: string | null, to: string | null): string {
  if (!from && !to) return ''
  return `${from ?? '—'}→${to ?? '—'}`
}

export function formatExpenseAmount(amount: number): string {
  return `¥${amount.toLocaleString()}`
}
