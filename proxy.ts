import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { computeSessionToken, timingSafeEqual } from '@/lib/auth'

export async function proxy(request: NextRequest) {
  const cookie = request.cookies.get('session')?.value ?? ''
  const expected = await computeSessionToken(process.env.AUTH_SECRET!)

  if (timingSafeEqual(cookie, expected)) {
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
