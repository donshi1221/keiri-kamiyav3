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

// 通し番号から年月へ戻す。
export function yearMonthOfIndex(index: number): YearMonth {
  const year = Math.floor((index - 1) / 12)
  return { year, month: index - year * 12 }
}

// まかなう範囲を持つ行。covers_from（いつからの分か）はクライアント請求の先取り行だけが持つ。
// 委託者支払いの行にはこの列が無い（＝常に行自身の月から）ので省略できる形にしてある。
type CoverRow = YearMonth & { months_covered: number; covers_from?: string | null }

// その行がまかなう月の範囲（通し番号で from〜to）。
// 始まりは covers_from があればその月、無ければ行自身の月。そこから months_covered か月。
// 「どの月がカバー済みか」を使う箇所は必ずこれを通す（始まりの決め方を1か所に閉じ込めるため）。
export function coverRange(row: CoverRow): { from: number; to: number } {
  const from = row.covers_from ? indexOfDate(row.covers_from) : monthIndex(row.year, row.month)
  return { from, to: from + row.months_covered - 1 }
}

// 自分の月以外の月をまかなう行（まとめ行・先取り行）かどうか。
// 先取り行は1か月分だけでも別の月をまかなうので、months_covered だけでは判定できない。
// SQL で同じ条件を書く箇所は lib/monthly-records の clientLumpRowCondition を使う。
export function isLumpRow(row: { months_covered: number; covers_from?: string | null }): boolean {
  return row.months_covered > 1 || row.covers_from != null
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

// target の月が、同じ内訳（またはアサイン）の「別の月の行」にカバーされているか。
// rows には同じ内訳・アサインの行だけを渡す。target と同じ月の行は数えない
// （その月自身の行は「カバーされている」のではなく、その月の行そのものなので）。
export function isCoveredByLump(rows: CoverRow[], target: YearMonth): boolean {
  const targetIndex = monthIndex(target.year, target.month)
  return rows.some((r) => {
    if (monthIndex(r.year, r.month) === targetIndex) return false
    const range = coverRange(r)
    return range.from <= targetIndex && targetIndex <= range.to
  })
}

// まとめる期間の表示。「2026年9月〜12月」、年をまたぐときは「2026年11月〜2027年2月」。
// 1か月だけ（先取り行で1か月分を請求するとき）は「2026年11月」。
export function lumpPeriodText(startYear: number, startMonth: number, months: number): string {
  if (months <= 1) return `${startYear}年${startMonth}月`
  const end = addMonthsOf(startYear, startMonth, months - 1)
  const endText = end.year === startYear ? `${end.month}月` : `${end.year}年${end.month}月`
  return `${startYear}年${startMonth}月〜${endText}`
}

// まとめる月数を決める。requested が無ければ残り全部。残りを超える指定はエラー文を返す
// （残り月数は行と契約から決まるため、画面の選択肢ではなくサーバー側で必ず確かめる）。
export function resolveLumpMonths(
  remaining: number,
  requested: number | undefined,
): { ok: true; months: number } | { ok: false; error: string } {
  const months = requested ?? remaining
  if (months > remaining) return { ok: false, error: `まとめられるのは最大${remaining}か月です。` }
  if (months < 2) return { ok: false, error: 'まとめる月数は2か月以上で指定してください。' }
  return { ok: true, months }
}

// 基準の年と同じ年なら「10月」、違う年なら「2027年1月」と書く。
function monthText(baseYear: number, ym: YearMonth): string {
  return ym.year === baseYear ? `${ym.month}月` : `${ym.year}年${ym.month}月`
}

// まとめたことで行が作られなくなる月の説明（確認ダイアログの注意書き）。
// 残り全部なら「以降は作られない」、途中までなら「どの月が作られず、いつから元に戻るか」を書く。
export function lumpSkipNote(year: number, month: number, months: number, remaining: number): string {
  const first = addMonthsOf(year, month, 1)
  if (months >= remaining) return `${monthText(year, first)}以降の行は作られなくなります。`
  const last = addMonthsOf(year, month, months - 1)
  const resume = addMonthsOf(year, month, months)
  const skipped =
    months === 2 ? monthText(year, first)
    : months === 3 ? `${monthText(year, first)}・${monthText(year, last)}`
    : `${monthText(year, first)}〜${monthText(year, last)}`
  return `${skipped}の行は作られません。${monthText(year, resume)}からは通常どおり毎月の行ができます。`
}

// まとめ行の内訳名（label_snapshot）。請求書に載る名前なので、何か月分をまとめたかを名前で読めるようにする。
export function lumpLabel(baseLabel: string, startYear: number, startMonth: number, months: number): string {
  // 1か月分だけの先取り行は「まとめて」ではないので、どの月の分かだけを書く。
  const period = months <= 1
    ? `${lumpPeriodText(startYear, startMonth, 1)}分`
    : `${lumpPeriodText(startYear, startMonth, months)}分・${months}か月まとめて`
  const base = baseLabel.trim()
  return base ? `${base}（${period}）` : period
}

// クライアント請求の行をまとめられない理由。まとめられるなら null。
// 送付済みの行は金額が確定しているので変えない。初回のみ（初期費用）や継続契約は「残り」が定まらない。
export function clientLumpBlockReason(
  row: YearMonth & { invoice_sent_at: string | null; months_covered: number; covers_from?: string | null },
  item: { one_time: boolean; contract_start: string | null; contract_months: number | null } | null | undefined,
): string | null {
  if (row.invoice_sent_at) return '請求書を送付済みの行はまとめられません。'
  if (isLumpRow(row)) return 'この行はすでにまとめてあります。'
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

// ─── まとめる範囲に、すでに後ろの月の行があるとき ─────────────────────────────
// 月初の自動生成で先に行ができていても、誰も触っていない行ならまとめに取り込んで消してよい
// （その月の分はまとめた月数に含まれるため）。人が記録を付けた行は消すと記録ごと失われるので断る。
// 「取り込めない理由」を返す関数にしてあるのは、画面の事前表示とAPIの判定で同じ文言を使うため。

// クライアント請求の後ろの月の行を取り込めない理由。取り込めるなら null。
export function clientLaterRowBlockCause(
  row: { invoice_sent_at: string | null; payment_confirmed_at: string | null; months_covered: number; covers_from?: string | null },
): string | null {
  if (row.invoice_sent_at) return '請求書を送付済みの'
  if (row.payment_confirmed_at) return '入金確認済みの'
  if (isLumpRow(row)) return 'すでに別のまとめ行になっている'
  return null
}

// 委託者支払いの後ろの月の行を取り込めない理由。取り込めるなら null。
// 「未操作」の考え方はアサイン編集時の期間外行の掃除（cleanupOutOfPeriodRecords）に揃えるが、
// 金額の控えを手で直しただけの行は取り込んでよい（まとめの合計額で置き換わるため）。
// hasExpense は同じアサイン・年月の立替経費の有無。経費は月次行ではなくアサイン＋年月に紐づくため、
// 行だけ消すと経費が宙に浮く。
export function payoutLaterRowBlockCause(
  row: {
    invoice_received_at: string | null
    payment_reserved_at: string | null
    contractor_paid_at: string | null
    actual_payout_amount: number | null
    delivered_video_count: number | null
    months_covered: number
  },
  hasExpense: boolean,
): string | null {
  if (row.invoice_received_at || row.payment_reserved_at || row.contractor_paid_at) return '受領・支払いの記録がある'
  if (row.actual_payout_amount != null || row.delivered_video_count != null) return '納品チェックの結果が入っている'
  if (hasExpense) return '立替経費が付いている'
  if (row.months_covered !== 1) return 'すでに別のまとめ行になっている'
  return null
}

// 取り込めない行があるときに利用者へ返す文。
export function laterRowBlockMessage(year: number, month: number, cause: string): string {
  return `${year}年${month}月の行は${cause}ため、まとめられません。`
}

// 後ろの月の行のうち、まとめる範囲（行の月の翌月 〜 行の月＋months−1）に入るもの。
export function laterRowsInRange<T extends YearMonth>(rows: T[], year: number, month: number, months: number): T[] {
  const from = monthIndex(year, month) + 1
  const to = monthIndex(year, month) + months - 1
  return rows.filter((r) => {
    const idx = monthIndex(r.year, r.month)
    return idx >= from && idx <= to
  })
}

// 行がまかなう期間の短い表記。「11月〜12月分」、1か月なら「11月分」。
// 行の年と違う年の月には年を付ける（「11月〜2027年2月分」）。
export function coverPeriodLabel(row: CoverRow): string {
  const range = coverRange(row)
  const from = monthText(row.year, yearMonthOfIndex(range.from))
  if (range.to === range.from) return `${from}分`
  return `${from}〜${monthText(row.year, yearMonthOfIndex(range.to))}分`
}

// まとめ行・先取り行にカバーされている月に出す説明。
// 「2026年9月の行でまとめ済み（9月〜12月分）」「2026年10月の行でまとめ済み（11月〜12月分）」。
export function coveredLumpNote(row: CoverRow): string {
  return `${row.year}年${row.month}月の行でまとめ済み（${coverPeriodLabel(row)}）`
}

// ─── まとめ済みの月に、続きの月の分を請求する（先取り行。クライアント請求のみ）─────────────
// 例: 契約が9〜12月で、9月の行に9・10月をまとめた。10月は行が無いが、10月のうちに11・12月分を請求したい。
// このとき10月に「11月からの2か月分」をまかなう行（covers_from=11月）を作る。

// 先取り行を作れるか、作れるならどの月から最大何か月か。
// rows にはその内訳の月次行をすべて渡す。(year, month) は請求を立てる月（＝まとめ済みで行が無い月）。
export function advancePlan(
  item: { active: boolean; one_time: boolean; contract_start: string | null; contract_months: number | null } | null | undefined,
  rows: CoverRow[],
  year: number,
  month: number,
): { ok: true; from: YearMonth; maxMonths: number } | { ok: false; error: string } {
  if (!item) return { ok: false, error: '請求内訳が見つかりません。' }
  if (!item.active) return { ok: false, error: '無効にした内訳には請求を追加できません。' }
  if (item.one_time) return { ok: false, error: '初回のみの内訳には続きの月がありません。' }
  if (!item.contract_start || item.contract_months == null) {
    return { ok: false, error: '契約開始月と契約期間が登録されていない内訳には追加できません。' }
  }
  const target = monthIndex(year, month)
  const hasRow = (index: number) => rows.some((r) => monthIndex(r.year, r.month) === index)
  const covered = (index: number) => isCoveredByLump(rows, yearMonthOfIndex(index))
  if (hasRow(target)) return { ok: false, error: 'この月にはすでに請求の行があります。' }
  if (!covered(target)) return { ok: false, error: 'この月はまとめ済みではありません。' }

  const last = indexOfDate(item.contract_start) + item.contract_months - 1
  // すでにカバー済みの月は飛ばし、その次の月から請求する。
  let from = target + 1
  while (from <= last && covered(from)) from++
  // 契約の最後まで請求済みか、次の月にもう行がある（その月の行で請求すればよい）なら続きは無い。
  if (from > last || hasRow(from)) return { ok: false, error: '続きの月はありません。' }

  let maxMonths = 0
  while (from + maxMonths <= last && !hasRow(from + maxMonths) && !covered(from + maxMonths)) maxMonths++
  return { ok: true, from: yearMonthOfIndex(from), maxMonths }
}

// 先取り行を作ると行が作られなくなる月の説明（確認ダイアログの注意書き）。
// baseYear は請求を立てる月の年（同じ年の月は年を省く）。
export function advanceSkipNote(baseYear: number, from: YearMonth, months: number): string {
  const last = addMonthsOf(from.year, from.month, months - 1)
  const skipped =
    months <= 1 ? monthText(baseYear, from)
    : months === 2 ? `${monthText(baseYear, from)}・${monthText(baseYear, last)}`
    : `${monthText(baseYear, from)}〜${monthText(baseYear, last)}`
  return `${skipped}の行は作られなくなります。`
}
