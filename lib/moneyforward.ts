import { db } from './db'
import { moneyforwardTokens } from './schema'
import { eq } from 'drizzle-orm'
import { encryptSecret, decryptSecret } from './crypto'
import { MF_EXPENSE_ACCOUNTS } from './config'

const MF_AUTH_URL = 'https://api.biz.moneyforward.com/authorize'
const MF_TOKEN_URL = 'https://api.biz.moneyforward.com/token'
const MF_API_BASE = 'https://api-accounting.moneyforward.com/api/v3'
const MF_TRIAL_BALANCE_PATH = '/reports/trial_balance_pl'
const MF_SCOPES = [
  'mfc/accounting/accounts.read',
  'mfc/accounting/report.read',
].join(' ')

export function getMFAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.MF_CLIENT_ID!,
    redirect_uri: process.env.MF_REDIRECT_URI!,
    response_type: 'code',
    scope: MF_SCOPES,
    state,
  })
  return `${MF_AUTH_URL}?${params}`
}

const MF_FETCH_TIMEOUT_MS = 15000

export async function exchangeCodeForTokens(code: string) {
  const res = await fetch(MF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MF_CLIENT_ID!,
      client_secret: process.env.MF_CLIENT_SECRET!,
      redirect_uri: process.env.MF_REDIRECT_URI!,
      grant_type: 'authorization_code',
      code,
    }),
    signal: AbortSignal.timeout(MF_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`MF token exchange failed: ${res.status}`)
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>
}

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch(MF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MF_CLIENT_ID!,
      client_secret: process.env.MF_CLIENT_SECRET!,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(MF_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`MF token refresh failed: ${res.status}`)
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>
}

export async function saveTokens(accessToken: string, refreshToken: string, expiresIn: number) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
  // トークンは平文でDBに残さず、必ず暗号化して保存する。
  // ENCRYPTION_KEY 未設定なら encryptSecret が例外→保存自体を失敗させる（フェイルクローズ）。
  const encAccess = encryptSecret(accessToken)
  const encRefresh = encryptSecret(refreshToken)
  const [existing] = await db.select({ id: moneyforwardTokens.id }).from(moneyforwardTokens).limit(1)
  if (existing) {
    await db.update(moneyforwardTokens).set({
      access_token: encAccess,
      refresh_token: encRefresh,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).where(eq(moneyforwardTokens.id, existing.id))
  } else {
    await db.insert(moneyforwardTokens).values({
      access_token: encAccess,
      refresh_token: encRefresh,
      expires_at: expiresAt,
    })
  }
}

// 有効なアクセストークンを返す（期限切れの場合は自動でリフレッシュ）
export async function getValidAccessToken(): Promise<string | null> {
  const [token] = await db.select().from(moneyforwardTokens).limit(1)
  if (!token) return null

  // 暗号化済みのトークンを復号する。旧・平文データや ENCRYPTION_KEY 未設定/不一致では
  // 復号に失敗する。その場合は「連携なし」とみなし、再連携を促す（袋小路にしない）。
  let accessToken: string
  let refreshToken: string
  try {
    accessToken = decryptSecret(token.access_token)
    refreshToken = decryptSecret(token.refresh_token)
  } catch {
    return null
  }

  const expiresAt = new Date(token.expires_at)
  const now = new Date()
  const fiveMinutes = 5 * 60 * 1000

  if (expiresAt.getTime() - now.getTime() > fiveMinutes) {
    return accessToken
  }

  try {
    const refreshed = await refreshAccessToken(refreshToken)
    await saveTokens(refreshed.access_token, refreshed.refresh_token, refreshed.expires_in)
    return refreshed.access_token
  } catch {
    return null
  }
}

type TrialBalanceRow = {
  type?: string
  name?: string
  code?: string | number
  account_code?: string | number
  values?: unknown[]
  rows?: TrialBalanceRow[]
  debit_amount?: number | string
  credit_amount?: number | string
}

type TrialBalanceResponse = {
  start_date?: string
  end_date?: string
  columns?: string[]
  rows?: TrialBalanceRow[]
  data?: { columns?: string[]; rows?: TrialBalanceRow[] }
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  const parsed = Number(value.replaceAll(',', ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function flattenAccountRows(rows: TrialBalanceRow[]): TrialBalanceRow[] {
  return rows.flatMap((row) => [
    ...(row.type === 'account' ? [row] : []),
    ...flattenAccountRows(row.rows ?? []),
  ])
}

function getTrialBalanceRows(data: TrialBalanceResponse): { columns: string[]; rows: TrialBalanceRow[] } {
  const source = data.data ?? data
  if (!Array.isArray(source.columns) || !Array.isArray(source.rows)) {
    throw new Error('MF API returned an unexpected trial balance response')
  }
  return { columns: source.columns, rows: flattenAccountRows(source.rows) }
}

function getAccountKeys(row: TrialBalanceRow): string[] {
  return [row.code, row.account_code, row.name]
    .filter((key): key is string | number => key !== undefined && key !== null)
    .map((key) => String(key).trim())
    .filter(Boolean)
}

function getCurrentPeriodExpense(row: TrialBalanceRow, columns: string[]): number {
  if (row.debit_amount !== undefined || row.credit_amount !== undefined) {
    return numberValue(row.debit_amount) - numberValue(row.credit_amount)
  }
  if (!Array.isArray(row.values)) return 0
  const debitIndex = columns.indexOf('debit_amount')
  const creditIndex = columns.indexOf('credit_amount')
  if (debitIndex < 0 || creditIndex < 0) {
    throw new Error('MF API trial balance response has no debit/credit columns')
  }
  return numberValue(row.values[debitIndex]) - numberValue(row.values[creditIndex])
}

// 指定月の「その他経費」をMFの損益試算表から取得する。
export async function fetchMFExpenses(year: number, month: number): Promise<number> {
  const accessToken = await getValidAccessToken()
  if (!accessToken) throw new Error('MF_NOT_CONNECTED')

  // 科目未設定時は、意図しない科目の取り込みを防ぐため0円として扱う。
  if (MF_EXPENSE_ACCOUNTS.length === 0) return 0

  const startDate = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`

  const params = new URLSearchParams({ start_date: startDate, end_date: endDate })
  if (process.env.MF_OFFICE_ID) params.set('office_id', process.env.MF_OFFICE_ID)
  const res = await fetch(`${MF_API_BASE}${MF_TRIAL_BALANCE_PATH}?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(MF_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`MF API error: ${res.status}`)

  const data = await res.json() as TrialBalanceResponse
  const { columns, rows } = getTrialBalanceRows(data)
  return rows.reduce((total, row) => {
    const keys = getAccountKeys(row)
    if (!keys.some((key) => MF_EXPENSE_ACCOUNTS.includes(key))) return total
    return total + getCurrentPeriodExpense(row, columns)
  }, 0)
}
