import { getGoogleDriveAuthUrl, isGoogleDriveOAuthConfigured } from '@/lib/google-drive'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  // 環境変数が無いままGoogleへ飛ばすと、意味の分からないGoogle側のエラー画面に着地する。
  // 手前で止めてマスタ管理画面に理由を返す。
  if (!isGoogleDriveOAuthConfigured() || !process.env.GOOGLE_OAUTH_REDIRECT_URI) {
    return NextResponse.redirect(new URL('/master?drive_error=not_configured', req.url))
  }

  const state = crypto.randomUUID()
  const res = NextResponse.redirect(getGoogleDriveAuthUrl(state))
  // state は「認可を始めたのがこのブラウザ本人か」をコールバックで照合するための使い捨ての値（CSRF対策）。
  res.cookies.set('gdrive_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })
  return res
}
