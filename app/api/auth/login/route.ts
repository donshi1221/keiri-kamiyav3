import { NextRequest } from 'next/server'
import { computeSessionToken } from '@/lib/auth'

export async function POST(req: NextRequest) {
  // APP_PASSWORD / AUTH_SECRET 未設定時はパスワード無しログインを許してしまうため、
  // 素通しさせず必ず拒否する（フェイルクローズ）。
  const appPassword = process.env.APP_PASSWORD
  const authSecret = process.env.AUTH_SECRET
  if (!appPassword || !authSecret) {
    return Response.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  const { password } = await req.json()

  if (password !== appPassword) {
    return Response.json({ error: 'Invalid password' }, { status: 401 })
  }

  const token = await computeSessionToken(authSecret)

  const res = Response.json({ ok: true })
  res.headers.set(
    'Set-Cookie',
    `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`
  )
  return res
}
