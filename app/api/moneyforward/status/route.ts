import { serverError } from '@/lib/api-error'
import { db } from '@/lib/db'
import { moneyforwardTokens } from '@/lib/schema'
import { getValidAccessToken } from '@/lib/moneyforward'

export async function GET() {
  try {
    const [data] = await db.select({
      updated_at: moneyforwardTokens.updated_at,
    }).from(moneyforwardTokens).limit(1)

    if (!data) {
      return Response.json({ connected: false, updatedAt: null })
    }

    // トークンが期限切れの場合は実際にリフレッシュを試み、失敗したら未連携扱いにする
    const accessToken = await getValidAccessToken()
    return Response.json({ connected: !!accessToken, updatedAt: data.updated_at })
  } catch (err) {
    return serverError(err)
  }
}
