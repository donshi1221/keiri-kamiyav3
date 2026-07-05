import { db } from '@/lib/db'
import { moneyforwardTokens } from '@/lib/schema'

export async function GET() {
  try {
    const [data] = await db.select({
      expires_at: moneyforwardTokens.expires_at,
      updated_at: moneyforwardTokens.updated_at,
    }).from(moneyforwardTokens).limit(1)
    return Response.json({ connected: !!data, updatedAt: data?.updated_at ?? null })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
