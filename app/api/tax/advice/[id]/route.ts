import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { taxAdviceEntries } from '@/lib/schema'
import { eq } from 'drizzle-orm'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/tax/advice/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()
    const [data] = await db.update(taxAdviceEntries).set({
      title: body.title,
      body: body.body,
      updated_at: new Date().toISOString(),
    }).where(eq(taxAdviceEntries.id, id)).returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/tax/advice/[id]'>
) {
  try {
    const { id } = await ctx.params
    await db.delete(taxAdviceEntries).where(eq(taxAdviceEntries.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err)
  }
}
