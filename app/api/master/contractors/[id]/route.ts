import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { contractors } from '@/lib/schema'
import { eq } from 'drizzle-orm'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/contractors/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()
    const [data] = await db.update(contractors).set({
      name: body.name,
      contractor_type: body.contractor_type,
      email: body.email ?? null,
      notes: body.notes ?? null,
    }).where(eq(contractors.id, id)).returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/contractors/[id]'>
) {
  try {
    const { id } = await ctx.params
    await db.delete(contractors).where(eq(contractors.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
