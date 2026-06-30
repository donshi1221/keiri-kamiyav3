import { exchangeCodeForTokens, saveTokens } from '@/lib/moneyforward'
import { redirect } from 'next/navigation'
import { NextRequest } from 'next/server'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) {
    return redirect('/?mf_error=no_code')
  }

  try {
    const tokens = await exchangeCodeForTokens(code)
    await saveTokens(tokens.access_token, tokens.refresh_token, tokens.expires_in)
    return redirect('/?mf_connected=1')
  } catch {
    return redirect('/?mf_error=token_failed')
  }
}
