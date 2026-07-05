import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clients, assignments } from '@/lib/schema'
import { eq, sql } from 'drizzle-orm'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/clients/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()
    const [data] = await db.update(clients).set({
      name: body.name,
      contact_person: body.contact_person ?? null,
      billing_amount: body.billing_amount ?? 0,
      contract_start: body.contract_start ?? null,
      contract_months: body.contract_months ? Number(body.contract_months) : null,
      notes: body.notes ?? null,
    }).where(eq(clients.id, id)).returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/clients/[id]'>
) {
  try {
    const { id } = await ctx.params

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(assignments)
      .where(eq(assignments.client_id, id))

    if (Number(count) > 0) {
      return Response.json(
        { error: `${count}件のアサインが存在するため削除できません。先にアサインを削除してください。` },
        { status: 409 }
      )
    }

    await db.delete(clients).where(eq(clients.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
