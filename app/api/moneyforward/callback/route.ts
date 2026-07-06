import { exchangeCodeForTokens, saveTokens } from '@/lib/moneyforward'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const savedState = req.cookies.get('mf_oauth_state')?.value

  if (!code || !state || !savedState || state !== savedState) {
    const res = NextResponse.redirect(new URL(!code ? '/?mf_error=no_code' : '/?mf_error=invalid_state', req.url))
    res.cookies.delete('mf_oauth_state')
    return res
  }

  let success = false
  try {
    const tokens = await exchangeCodeForTokens(code)
    await saveTokens(tokens.access_token, tokens.refresh_token, tokens.expires_in)
    success = true
  } catch {
    success = false
  }

  const res = NextResponse.redirect(new URL(success ? '/?mf_connected=1' : '/?mf_error=token_failed', req.url))
  res.cookies.delete('mf_oauth_state')
  return res
}
