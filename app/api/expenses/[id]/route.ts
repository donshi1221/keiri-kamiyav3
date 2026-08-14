import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { expenses } from '@/lib/schema'
import { eq } from 'drizzle-orm'

// 請求書送付チェックの付け外し。金額・内容の編集は設けない（消して入れ直す運用）。
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/expenses/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = (await req.json().catch(() => null)) as { checked?: boolean } | null
    if (typeof body?.checked !== 'boolean') {
      return Response.json({ error: 'checked (boolean) is required' }, { status: 400 })
    }
    const [updated] = await db
      .update(expenses)
      .set({ invoice_sent_at: body.checked ? new Date().toISOString() : null })
      .where(eq(expenses.id, id))
      .returning()
    if (!updated) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(updated)
  } catch (err) {
    return serverError(err)
  }
}

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
