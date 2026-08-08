import { serverError } from '@/lib/api-error'
import { db } from '@/lib/db'
import { googleDriveTokens } from '@/lib/schema'
import { getValidAccessToken, isGoogleDriveOAuthConfigured } from '@/lib/google-drive'
import type { GoogleDriveStatus } from '@/lib/ui-types'

export async function GET() {
  try {
    const configured = isGoogleDriveOAuthConfigured() && !!process.env.GOOGLE_DRIVE_FOLDER_ID

    const [data] = await db.select({
      updated_at: googleDriveTokens.updated_at,
    }).from(googleDriveTokens).limit(1)

    if (!data) {
      return Response.json({ configured, connected: false, updatedAt: null } satisfies GoogleDriveStatus)
    }

    // トークンの行が存在するだけでは「連携中」と言えない（リフレッシュトークン失効時も行は残る）。
    // 期限切れなら実際にリフレッシュを試み、失敗したら未連携扱いにする。
    const token = await getValidAccessToken()
    return Response.json({
      configured,
      connected: 'token' in token,
      updatedAt: data.updated_at,
    } satisfies GoogleDriveStatus)
  } catch (err) {
    return serverError(err)
  }
}
