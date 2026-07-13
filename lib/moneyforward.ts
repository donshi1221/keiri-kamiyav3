import { db } from './db'
import { moneyforwardTokens } from './schema'
import { eq } from 'drizzle-orm'
import { encryptSecret, decryptSecret } from './crypto'

const MF_AUTH_URL = 'https://id.moneyforward.com/oauth/authorize'
const MF_TOKEN_URL = 'https://id.moneyforward.com/oauth/token'
const MF_API_BASE = 'https://accounting.api.moneyforward.com/api/v1'

export function getMFAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.MF_CLIENT_ID!,
    redirect_uri: process.env.MF_REDIRECT_URI!,
    response_type: 'code',
    scope: 'mf_accounting',
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

// 指定月の経費合計をMFから取得
export async function fetchMFExpenses(year: number, month: number): Promise<number> {
  const accessToken = await getValidAccessToken()
  if (!accessToken) throw new Error('MF_NOT_CONNECTED')

  const startDate = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`

  // MFクラウド会計 APIから支出取引（type=payment）を全件取得（無限ループ防止のためページ数に上限を設ける）
  const MAX_PAGES = 50
  let total = 0
  let page = 1
  while (page <= MAX_PAGES) {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      type: 'payment',
      page: String(page),
      limit: '100',
    })
    const res = await fetch(`${MF_API_BASE}/deals?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(MF_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`MF API error: ${res.status}`)
    const data = await res.json() as { data: Array<{ amount: number }>; meta?: { total_count?: number } }
    for (const deal of data.data ?? []) {
      total += Math.abs(deal.amount)
    }
    if ((data.data?.length ?? 0) < 100) break
    page++
  }
  return total
}
