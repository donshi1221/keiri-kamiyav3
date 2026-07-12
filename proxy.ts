import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { computeSessionToken, timingSafeEqual } from '@/lib/auth'

export async function proxy(request: NextRequest) {
  // AUTH_SECRET 未設定だと誰でも計算可能な固定トークンで認証が通ってしまうため、
  // 未設定時は認証成立とみなさず必ず拒否する（フェイルクローズ）。
  const authSecret = process.env.AUTH_SECRET
  const cookie = request.cookies.get('session')?.value ?? ''
  const expected = authSecret ? await computeSessionToken(authSecret) : null

  if (expected !== null && timingSafeEqual(cookie, expected)) {
    return NextResponse.next()
  }

  if (request.nextUrl.pathname.startsWith('/api/')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.redirect(new URL('/login', request.url))
}

export const config = {
  matcher: [
    '/((?!login|api/auth/login|api/cron|_next/static|_next/image|favicon.ico).*)',
  ],
}
