// Google スプレッドシート（編集者の納品表）を APIキー方式で読み、
// 「対象月に納品すべき本数／実際に納品済みの本数」を数えるためのユーティリティ。
// - タブ名の表記ゆれ（6月度 / 6月分 / 6月 / 6月10日 …）に対応して対象月タブを選ぶ。
// - DB は一切変更しない（読むだけ・数えるだけ）。
// - 失敗しても例外を投げず、状態(status)に載せて返す（1件の失敗で全体を止めないため）。
import { DELIVERY_COL_DEADLINE, DELIVERY_COL_URL, DELIVERY_HEADER_ROWS } from './config'
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

// タブ名から対象月（N月）を含むものを選ぶ。数字直前に別の数字が来る誤検出（例:16月）は除外する。
export function pickMonthTab(
  tabs: SheetTab[],
  month: number
): { tab: SheetTab | null; ambiguous: boolean; matchedTitles: string[] } {
  const re = new RegExp(`(?:^|[^0-9])${month}月`)
  const matched = tabs.filter((t) => re.test(normalizeSheetText(t.title)))
  return { tab: matched[0] ?? null, ambiguous: matched.length > 1, matchedTitles: matched.map((t) => t.title) }
}

// 「6月3日」「6/3」「2026/6/3」等が対象月を指すか。年は問わない（対象年月はタブ選択で担保）。
function isDeadlineInMonth(raw: string, month: number): boolean {
  const s = normalizeSheetText(raw).trim()
  if (!s) return false
  const jp = s.match(/(\d{1,2})\s*月/)
  if (jp) return Number(jp[1]) === month
  const slash = s.match(/(?:\d{4}\/)?(\d{1,2})\/\d{1,2}/)
  if (slash) return Number(slash[1]) === month
  return false
}

// A列(〆切)が対象月の行を「すべき」、そのうちD列(URL)が非空の行を「済み」として数える。
export function countDeliveries(values: string[][], month: number): { expected: number; delivered: number } {
  let expected = 0
  let delivered = 0
  for (const row of values.slice(DELIVERY_HEADER_ROWS)) {
    if (!isDeadlineInMonth(row[DELIVERY_COL_DEADLINE] ?? '', month)) continue
    expected++
    if ((row[DELIVERY_COL_URL] ?? '').trim().length > 0) delivered++
  }
  return { expected, delivered }
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

// 1アサイン分のシートを読み、対象月の納品集計を返す。例外は投げず status に載せる。
export async function checkAssignmentDelivery(
  input: DeliveryAssignmentInput,
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
    expected: null,
    delivered: null,
    message: null,
  }

  const apiKey = process.env.GOOGLE_SHEETS_API_KEY
  if (!apiKey) return { ...base, status: 'no_api_key', message: 'APIキー(GOOGLE_SHEETS_API_KEY)が未設定です' }
  if (!input.spreadsheetUrl) return { ...base, status: 'no_url', message: 'スプレッドシートURLが未登録です' }

  const spreadsheetId = extractSpreadsheetId(input.spreadsheetUrl)
  if (!spreadsheetId) return { ...base, status: 'bad_url', message: 'URLからスプレッドシートIDを取得できません' }

  try {
    const tabs = await fetchTabs(spreadsheetId, apiKey)
    const { tab, ambiguous, matchedTitles } = pickMonthTab(tabs, month)
    if (!tab) return { ...base, status: 'no_tab', message: `「${month}月」を含むタブが見つかりません` }
    if (ambiguous) {
      return {
        ...base,
        status: 'ambiguous_tab',
        tabTitle: tab.title,
        message: `「${month}月」に一致するタブが複数あります（${matchedTitles.join(' / ')}）。タブ名を1つに整理してください`,
      }
    }
    const values = await fetchTabValues(spreadsheetId, tab.title, apiKey)
    const { expected, delivered } = countDeliveries(values, month)
    return { ...base, status: 'ok', tabTitle: tab.title, expected, delivered }
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
