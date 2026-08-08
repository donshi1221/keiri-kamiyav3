import { exchangeCodeForTokens, saveTokens } from '@/lib/google-drive'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const savedState = req.cookies.get('gdrive_oauth_state')?.value

  if (!code || !state || !savedState || state !== savedState) {
    const res = NextResponse.redirect(
      new URL(!code ? '/master?drive_error=no_code' : '/master?drive_error=invalid_state', req.url)
    )
    res.cookies.delete('gdrive_oauth_state')
    return res
  }

  let success = false
  try {
    const tokens = await exchangeCodeForTokens(code)
    // access_type=offline と prompt=consent を付けているので通常は refresh_token が返るが、
    // 返らなければ期限切れ後に更新できず「連携したのに数十分で止まる」状態になる。保存せず失敗として扱う。
    if (tokens.refresh_token) {
      await saveTokens(tokens.access_token, tokens.refresh_token, tokens.expires_in)
      success = true
    }
  } catch {
    success = false
  }

  const res = NextResponse.redirect(
    new URL(success ? '/master?drive_connected=1' : '/master?drive_error=token_failed', req.url)
  )
  res.cookies.delete('gdrive_oauth_state')
  return res
}
