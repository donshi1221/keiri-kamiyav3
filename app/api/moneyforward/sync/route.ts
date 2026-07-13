import { fetchMFExpenses } from '@/lib/moneyforward'
import { db } from '@/lib/db'
import { moneyforwardExpenses } from '@/lib/schema'
import { NextRequest } from 'next/server'
import { serverError } from '@/lib/api-error'

// 関数のタイムアウト上限（秒）。MoneyForward APIを複数ページ取得するため、
// 既定の短いタイムアウトだと途中で切れうる。Vercel の仕様上リテラルで指定する必要がある。
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const { year, month } = await req.json() as { year: number; month: number }

  if (!year || !month) {
    return Response.json({ error: 'year and month are required' }, { status: 400 })
  }

  try {
    const amount = await fetchMFExpenses(year, month)
    await db.insert(moneyforwardExpenses)
      .values({ year, month, amount, synced_at: new Date().toISOString() })
      .onConflictDoUpdate({
        target: [moneyforwardExpenses.year, moneyforwardExpenses.month],
        set: { amount, synced_at: new Date().toISOString() },
      })
    return Response.json({ ok: true, amount })
  } catch (err) {
    // MF未連携はエラーではなく想定内の状態なので、専用の401で返す（内部メッセージは出さない）。
    const message = err instanceof Error ? err.message : 'unknown'
    if (message === 'MF_NOT_CONNECTED') {
      return Response.json({ error: 'not_connected' }, { status: 401 })
    }
    return serverError(err, 'moneyforward/sync')
  }
}
