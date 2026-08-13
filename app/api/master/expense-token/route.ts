import { serverError } from '@/lib/api-error'
import { getOrCreateExpenseUploadToken, reissueExpenseUploadToken } from '@/lib/expense-token'

// 受付URLの公開側は /api/expense-inbox（認証除外）。こちらは /api/master 配下に置くことで
// proxy.ts の既定の保護対象に入れ、除外パターンの前方一致でうっかり公開されるのを構造的に防ぐ。

export async function GET() {
  try {
    return Response.json({ token: await getOrCreateExpenseUploadToken() })
  } catch (err) {
    return serverError(err)
  }
}

// 再発行。古いトークンは上書きされ、配布済みの旧URLはその時点で無効になる。
export async function POST() {
  try {
    return Response.json({ token: await reissueExpenseUploadToken() })
  } catch (err) {
    return serverError(err)
  }
}
