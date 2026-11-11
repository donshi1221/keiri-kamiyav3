// Google スプレッドシート（編集者の納品表）を APIキー方式で読み、
// 「対象月に納品すべき本数／実際に納品済みの本数」を数えるためのユーティリティ。
// - タブ名の表記ゆれ（6月度 / 6月分 / 6月 / 6月10日 …）に対応して対象月タブを選ぶ。
// - DB は一切変更しない（読むだけ・数えるだけ）。
// - 失敗しても例外を投げず、状態(status)に載せて返す（1件の失敗で全体を止めないため）。
import { DELIVERY_COL_DEADLINE, DELIVERY_COL_URL, DELIVERY_HEADER_ROWS } from './config'
import { isRevisionLabel } from './invoice-match'
import type { DeliveryCheckRow } from './ui-types'

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

class SheetsError extends Error {
  constructor(public httpStatus: number) {
    super(`Google Sheets API responded with ${httpStatus}`)
    this.name = 'SheetsError'
  }
}

interface SheetTab {
  title: string
  sheetId: number
}

// Google Sheets上では、タブ名や日付が全角数字で入力されることがある。
// 判定前にASCII範囲の全角文字と全角スペースを半角へ統一し、表記ゆれを吸収する。
function normalizeSheetText(value: string): string {
  return value
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
}

// 共有URLから spreadsheetId を取り出す。例: .../spreadsheets/d/<ID>/edit?gid=... → <ID>
export function extractSpreadsheetId(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  return m ? m[1] : null
}

// 特定のタブを直接開くURL。gid はタブごとの内部IDで、これを付けるとそのタブが選択された状態で開く。
// 本数がずれたときに「どの行が未記入か」をすぐ確認できるようにするため、月タブまで案内する。
export function buildTabUrl(spreadsheetId: string, sheetId: number): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`
}

// 年は「2026」でも「26」（＝2000を足す）でも書かれる。
function toFullYear(digits: string): number {
  const n = Number(digits)
  return digits.length <= 2 ? 2000 + n : n
}

// 「26年10月」「2026年10月度」のように年が明記されたタブ名。数字直前に別の数字が来る誤検出
// （例: 126年）は、直前が数字でないことを条件にして除く。
const YEAR_MONTH_TAB_PATTERN = /(?:^|[^0-9])(\d{4}|\d{2})\s*年\s*(\d{1,2})\s*月/

// タブ名から対象年月のタブを選ぶ。月の誤検出（例: 16月・「11月」を「1月」）は、数字直前に別の数字が来る形を除いて防ぐ。
// 年を明記したタブ（「26年10月」）があればそれを優先し、無ければ年なしタブ（「10月度」）を使う。
// 別の年と明記されたタブ（前年同月の「25年10月」など）は候補に入れない。
// 年入りが2枚以上、または年なしが2枚以上のときは1枚に決められないので ambiguous にする。
export function pickMonthTab(
  tabs: SheetTab[],
  year: number,
  month: number
): { tab: SheetTab | null; ambiguous: boolean; matchedTitles: string[] } {
  const monthPattern = new RegExp(`(?:^|[^0-9])${month}月`)
  const sameYear: SheetTab[] = []
  const noYear: SheetTab[] = []
  for (const tab of tabs) {
    const title = normalizeSheetText(tab.title)
    const dated = title.match(YEAR_MONTH_TAB_PATTERN)
    if (dated) {
      if (Number(dated[2]) === month && toFullYear(dated[1]) === year) sameYear.push(tab)
      continue
    }
    if (monthPattern.test(title)) noYear.push(tab)
  }
  const matched = sameYear.length > 0 ? sameYear : noYear
  return { tab: matched[0] ?? null, ambiguous: matched.length > 1, matchedTitles: matched.map((t) => t.title) }
}

// 「6月3日」「6/3」「2026/6/3」「26年6月3日」等が対象年月を指すか。
// 年が明記されているときだけ対象年と比べる（前年の行がタブに残っていても数えないため）。
// 年が書かれていない行は、従来どおり月だけで判定する（対象年月はタブ選択で担保）。
function isDeadlineInMonth(raw: string, year: number, month: number): boolean {
  const s = normalizeSheetText(raw).trim()
  if (!s) return false
  const jp = s.match(/(?:(?:^|[^0-9])(\d{4}|\d{2})\s*年\s*)?(\d{1,2})\s*月/)
  if (jp) return (jp[1] === undefined || toFullYear(jp[1]) === year) && Number(jp[2]) === month
  const slash = s.match(/(?:(\d{4})\/)?(\d{1,2})\/\d{1,2}/)
  if (slash) return (slash[1] === undefined || Number(slash[1]) === year) && Number(slash[2]) === month
  return false
}

// A列(〆切)が「◯月◯日」やスラッシュ形式（(YYYY/)M/D）の日付として読めるか。
// 月が一致するかは問わない（isDeadlineInMonth と役割を分ける）。
function parsesAsDate(raw: string): boolean {
  const s = normalizeSheetText(raw).trim()
  if (!s) return false
  if (/(\d{1,2})\s*月/.test(s)) return true
  if (/(?:\d{4}\/)?(\d{1,2})\/\d{1,2}/.test(s)) return true
  return false
}

// 修正の行か。タイトル欄に「追加修正」と書く月もあれば、通常のタイトルの行の横（E列など）に
// 「追加修正料金1,000円」とメモを書く月もあるため、URL列以外のどの列に書かれていても拾う。
// 判定の言葉は請求書の明細と同じ（lib/invoice-match の isRevisionLabel。「修正版」「修正済」は外す）。
function isRevisionRow(row: string[]): boolean {
  return row.some((cell, index) => index !== DELIVERY_COL_URL && isRevisionLabel(normalizeSheetText(cell ?? '')))
}

// A列(〆切)が対象年月の行を「すべき」、そのうちD列(URL)が非空の行を「済み」として数える。
// 〆切に年が書かれていて対象年と違う行（前年の同月の行がタブに残っているなど）は数えない。
// 修正の行は通常の本数（すべき・済み）に含めず、revisions として別に数える。修正は1本分の単価ではなく
// 修正費として別に払う（払うかは請求書チェックで人が決める）ため、本数に入れると支払予定が1本分多くなり、
// 修正を除いて書かれた請求書が「本数が少ない」とNGになってしまう。
export function countDeliveries(
  values: string[][],
  year: number,
  month: number
): { expected: number; delivered: number; revisions: number } {
  let expected = 0
  let delivered = 0
  let revisions = 0
  for (const row of values.slice(DELIVERY_HEADER_ROWS)) {
    const deadline = row[DELIVERY_COL_DEADLINE] ?? ''
    const hasUrl = (row[DELIVERY_COL_URL] ?? '').trim().length > 0

    // A列が日付として解釈できない行（空欄や「1」等）は、タブ名自体が対象月を表しており、
    // 〆切を日付形式で書かない運用が実際のシートに存在するための救済措置。
    // URLが貼られている＝納品済みは確実なので、対象月タブのものとして拾う。
    // ただし別の月の日付として読める行（例: 7月度タブに8/1）は従来どおり数えない（月またぎ誤カウント防止）。
    const inMonth = isDeadlineInMonth(deadline, year, month)
    if (!inMonth && !(!parsesAsDate(deadline) && hasUrl)) continue

    if (isRevisionRow(row)) {
      revisions++
      continue
    }
    expected++
    if (hasUrl) delivered++
  }
  return { expected, delivered, revisions }
}

async function fetchJson(url: string): Promise<unknown> {
  // スプレッドシートは頻繁に更新されるため、常に最新を読む（キャッシュしない）。
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new SheetsError(res.status)
  return res.json()
}

async function fetchTabs(spreadsheetId: string, apiKey: string): Promise<SheetTab[]> {
  const url = `${SHEETS_API_BASE}/${spreadsheetId}?fields=sheets.properties(title,sheetId)&key=${apiKey}`
  const json = (await fetchJson(url)) as { sheets?: Array<{ properties?: { title?: string; sheetId?: number } }> }
  return (json.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is { title: string; sheetId?: number } => !!p && typeof p.title === 'string')
    .map((p) => ({ title: p.title, sheetId: p.sheetId ?? 0 }))
}

async function fetchTabValues(spreadsheetId: string, tabTitle: string, apiKey: string): Promise<string[][]> {
  const range = encodeURIComponent(tabTitle)
  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${range}?majorDimension=ROWS&key=${apiKey}`
  const json = (await fetchJson(url)) as { values?: string[][] }
  return json.values ?? []
}

export interface DeliveryAssignmentInput {
  assignmentId: string
  contractorName: string
  clientName: string
  roleName: string
  spreadsheetUrl: string | null
}

// 1アサイン分のシートを読み、対象年月の納品集計を返す。例外は投げず status に載せる。
// year / month は「納品月」（支払月ではない）。
export async function checkAssignmentDelivery(
  input: DeliveryAssignmentInput,
  year: number,
  month: number
): Promise<DeliveryCheckRow> {
  const base: DeliveryCheckRow = {
    assignmentId: input.assignmentId,
    contractorName: input.contractorName,
    clientName: input.clientName,
    roleName: input.roleName,
    spreadsheetUrl: input.spreadsheetUrl,
    status: 'ok',
    tabTitle: null,
    tabUrl: null,
    expected: null,
    delivered: null,
    revisions: null,
    message: null,
  }

  const apiKey = process.env.GOOGLE_SHEETS_API_KEY
  if (!apiKey) return { ...base, status: 'no_api_key', message: 'APIキー(GOOGLE_SHEETS_API_KEY)が未設定です' }
  if (!input.spreadsheetUrl) return { ...base, status: 'no_url', message: 'スプレッドシートURLが未登録です' }

  const spreadsheetId = extractSpreadsheetId(input.spreadsheetUrl)
  if (!spreadsheetId) return { ...base, status: 'bad_url', message: 'URLからスプレッドシートIDを取得できません' }

  try {
    const tabs = await fetchTabs(spreadsheetId, apiKey)
    const { tab, ambiguous, matchedTitles } = pickMonthTab(tabs, year, month)
    if (!tab) return { ...base, status: 'no_tab', message: `「${year}年${month}月」（年なしなら「${month}月」）を含むタブが見つかりません` }
    const tabUrl = buildTabUrl(spreadsheetId, tab.sheetId)
    if (ambiguous) {
      return {
        ...base,
        status: 'ambiguous_tab',
        tabTitle: tab.title,
        tabUrl,
        message: `「${month}月」に一致するタブが複数あります（${matchedTitles.join(' / ')}）。タブ名を1つに整理してください`,
      }
    }
    const values = await fetchTabValues(spreadsheetId, tab.title, apiKey)
    const { expected, delivered, revisions } = countDeliveries(values, year, month)
    return { ...base, status: 'ok', tabTitle: tab.title, tabUrl, expected, delivered, revisions }
  } catch (err) {
    if (err instanceof SheetsError) {
      if (err.httpStatus === 403) {
        return { ...base, status: 'forbidden', message: '読み取り権限がありません（「リンクを知っている全員が閲覧可」か、APIキーの制限をご確認ください）' }
      }
      if (err.httpStatus === 404) {
        return { ...base, status: 'fetch_error', message: 'スプレッドシートが見つかりません（URLをご確認ください）' }
      }
      return { ...base, status: 'fetch_error', message: `取得に失敗しました（HTTP ${err.httpStatus}）` }
    }
    return { ...base, status: 'fetch_error', message: '取得中に予期しないエラーが発生しました' }
  }
}
