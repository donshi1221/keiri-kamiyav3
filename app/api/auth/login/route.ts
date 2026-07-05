import { NextRequest } from 'next/server'
import { computeSessionToken } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const { password } = await req.json()

  if (password !== process.env.APP_PASSWORD) {
    return Response.json({ error: 'Invalid password' }, { status: 401 })
  }

  const token = await computeSessionToken(process.env.AUTH_SECRET!)

  const res = Response.json({ ok: true })
  res.headers.set(
    'Set-Cookie',
    `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`
  )
  return res
}
