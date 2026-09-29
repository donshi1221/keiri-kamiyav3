import { addMonthsOf } from './dates'

// 「残りの月をまとめて1回で請求・支払いする」ための共通ロジック。
// まとめた行は months_covered（その1行で何か月分をまかなうか）を 2 以上にして持ち、
// カバーされる月は月次生成で行を作らない。判定が画面・API・月次生成で食い違うと
// 「ボタンは出るのにAPIが断る」「まとめたのに翌月も行ができる」になるため、ここ1か所に置く。
// 画面（クライアントコンポーネント）からも読むので、db など server-only なものは import しない。

type YearMonth = { year: number; month: number }

// 年月の大小・差は「年×12＋月」の通し番号で扱う（年をまたぐ比較を場合分けせずに済む）。
export function monthIndex(year: number, month: number): number {
  return year * 12 + month
}

// 'YYYY-MM-DD'（date 列の文字列）から通し番号を出す。
function indexOfDate(date: string): number {
  const [y, m] = date.split('-').map(Number)
  return monthIndex(y, m)
}

// その行の月を含めて、契約（支払期間）の最後の月まで何か月あるか。
// 開始月・月数のどちらかが無い（＝継続契約で終わりが無い）か、行の月が期間外なら null。
export function remainingMonths(
  row: YearMonth,
  start: string | null,
  count: number | null,
): number | null {
  if (!start || count == null) return null
  const startIndex = indexOfDate(start)
  const rowIndex = monthIndex(row.year, row.month)
  const lastIndex = startIndex + count - 1
  if (rowIndex < startIndex || rowIndex > lastIndex) return null
  return lastIndex - rowIndex + 1
}

// target の月が、同じ内訳（またはアサイン）の既存のまとめ行にカバーされているか。
// rows には同じ内訳・アサインの行だけを渡す（months_covered が 1 の行は何もカバーしない）。
export function isCoveredByLump(
  rows: { year: number; month: number; months_covered: number }[],
  target: YearMonth,
): boolean {
  const targetIndex = monthIndex(target.year, target.month)
  return rows.some((r) => {
    const idx = monthIndex(r.year, r.month)
    return idx < targetIndex && idx + r.months_covered - 1 >= targetIndex
  })
}

// まとめる期間の表示。「2026年9月〜12月」、年をまたぐときは「2026年11月〜2027年2月」。
export function lumpPeriodText(startYear: number, startMonth: number, months: number): string {
  const end = addMonthsOf(startYear, startMonth, months - 1)
  const endText = end.year === startYear ? `${end.month}月` : `${end.year}年${end.month}月`
  return `${startYear}年${startMonth}月〜${endText}`
}

// まとめ行の内訳名（label_snapshot）。請求書に載る名前なので、何か月分をまとめたかを名前で読めるようにする。
export function lumpLabel(baseLabel: string, startYear: number, startMonth: number, months: number): string {
  const period = `${lumpPeriodText(startYear, startMonth, months)}分・${months}か月まとめて`
  const base = baseLabel.trim()
  return base ? `${base}（${period}）` : period
}

// クライアント請求の行をまとめられない理由。まとめられるなら null。
// 送付済みの行は金額が確定しているので変えない。初回のみ（初期費用）や継続契約は「残り」が定まらない。
export function clientLumpBlockReason(
  row: YearMonth & { invoice_sent_at: string | null; months_covered: number },
  item: { one_time: boolean; contract_start: string | null; contract_months: number | null } | null | undefined,
): string | null {
  if (row.invoice_sent_at) return '請求書を送付済みの行はまとめられません。'
  if (row.months_covered !== 1) return 'この行はすでにまとめてあります。'
  if (!item) return '請求内訳が見つかりません。'
  if (item.one_time) return '初回のみの内訳はまとめられません。'
  if (!item.contract_start || item.contract_months == null) return '契約開始月と契約期間が登録されていない内訳はまとめられません。'
  const remaining = remainingMonths(row, item.contract_start, item.contract_months)
  if (remaining == null || remaining < 2) return '残りが2か月以上ないため、まとめられません。'
  return null
}

// 委託者支払いの行をまとめられない理由。まとめられるなら null。
// 編集者は納品本数で毎月の金額が変わるため、先の月の分を前払いでまとめる対象にしない。
export function payoutLumpBlockReason(
  row: YearMonth & { contractor_paid_at: string | null; months_covered: number },
  assignment: { payment_start_month: string | null; payment_count: number | null } | null | undefined,
  contractorType: string | null | undefined,
): string | null {
  if (row.contractor_paid_at) return '支払い済みの行はまとめられません。'
  if (row.months_covered !== 1) return 'この行はすでにまとめてあります。'
  if (!assignment) return 'アサインが見つかりません。'
  if (contractorType === 'video_editor') return '編集者への支払いはまとめられません。'
  if (!assignment.payment_start_month || assignment.payment_count == null) return '支払開始月と支払回数が登録されていないアサインはまとめられません。'
  const remaining = remainingMonths(row, assignment.payment_start_month, assignment.payment_count)
  if (remaining == null || remaining < 2) return '残りが2か月以上ないため、まとめられません。'
  return null
}
