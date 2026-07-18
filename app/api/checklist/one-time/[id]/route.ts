import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { oneTimeTasks } from '@/lib/schema'
import { eq } from 'drizzle-orm'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/checklist/one-time/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()

    // 冪等化: クライアントが「完了/未完了」を completed で明示的に送る（トグルしない）。
    if (typeof body.completed !== 'boolean') {
      return Response.json({ error: 'completed (boolean) is required' }, { status: 400 })
    }

    const [data] = await db.update(oneTimeTasks)
      .set({ completed_at: body.completed ? new Date().toISOString() : null })
      .where(eq(oneTimeTasks.id, id))
      .returning()

    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/checklist/one-time/[id]'>
) {
  try {
    const { id } = await ctx.params
    await db.delete(oneTimeTasks).where(eq(oneTimeTasks.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err)
  }
}
