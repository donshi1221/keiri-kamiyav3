import { NextRequest } from 'next/server'
import { createSessionToken } from '@/lib/auth'

// 設定値は環境変数で調整可能にする（未設定時は妥当なデフォルトを使う）。
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30)
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS ?? 10)
const LOGIN_WINDOW_MINUTES = Number(process.env.LOGIN_WINDOW_MINUTES ?? 10)

const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = LOGIN_WINDOW_MINUTES * 60 * 1000

// IP ごとの試行回数をメモリ上で数える簡易レート制限。
// Vercel のサーバーレスはインスタンスごとにメモリが分かれ、再起動で消えるため best-effort。
// 単一ユーザー・共通パスワードの用途では総当たりの緩和策として十分と判断（DB永続化まではしない）。
const attempts = new Map<string, { count: number; resetAt: number }>()

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

export async function POST(req: NextRequest) {
  // APP_PASSWORD / AUTH_SECRET 未設定時はパスワード無しログインを許してしまうため、
  // 素通しさせず必ず拒否する（フェイルクローズ）。
  const appPassword = process.env.APP_PASSWORD
  const authSecret = process.env.AUTH_SECRET
  if (!appPassword || !authSecret) {
    return Response.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  const ip = getClientIp(req)
  const now = Date.now()
  const record = attempts.get(ip)

  // 時間枠が切れていたらカウントをリセットする。
  const current = record && record.resetAt > now ? record : { count: 0, resetAt: now + LOGIN_WINDOW_MS }

  if (current.count >= LOGIN_MAX_ATTEMPTS) {
    return Response.json(
      { error: '試行回数が上限に達しました。しばらくしてからお試しください。' },
      { status: 429 }
    )
  }

  const { password } = await req.json()

  if (password !== appPassword) {
    // 失敗のみカウントする。
    attempts.set(ip, { count: current.count + 1, resetAt: current.resetAt })
    return Response.json({ error: 'Invalid password' }, { status: 401 })
  }

  // 成功したらそのIPのカウントを解除する。
  attempts.delete(ip)

  const token = await createSessionToken(authSecret, SESSION_TTL_MS)

  const res = Response.json({ ok: true })
  res.headers.set(
    'Set-Cookie',
    `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  )
  return res
}
