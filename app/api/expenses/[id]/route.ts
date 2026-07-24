import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { expenses } from '@/lib/schema'
import { eq } from 'drizzle-orm'

// 経費は編集を設けず「消して入れ直す」運用のため、削除のみ用意する。
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/expenses/[id]'>
) {
  try {
    const { id } = await ctx.params
    const [deleted] = await db.delete(expenses).where(eq(expenses.id, id)).returning()
    if (!deleted) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
