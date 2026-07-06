import { getMFAuthUrl } from '@/lib/moneyforward'
import { NextResponse } from 'next/server'

export async function GET() {
  const state = crypto.randomUUID()
  const url = getMFAuthUrl(state)
  const res = NextResponse.redirect(url)
  res.cookies.set('mf_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })
  return res
}
