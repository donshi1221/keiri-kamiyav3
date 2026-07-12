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

    // リクエストに含まれた項目だけを更新対象にする（undefined のキーは触らない）。
    // これをしないと、UIが一部の項目だけ送った場合に未送信の項目が null / 0 上書きで消える。
    const patch: Partial<typeof clients.$inferInsert> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.contact_person !== undefined) patch.contact_person = body.contact_person
    if (body.billing_amount !== undefined) patch.billing_amount = body.billing_amount
    if (body.contract_start !== undefined) patch.contract_start = body.contract_start
    if (body.contract_months !== undefined) {
      patch.contract_months = body.contract_months ? Number(body.contract_months) : null
    }
    if (body.notes !== undefined) patch.notes = body.notes

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    const [data] = await db.update(clients).set(patch).where(eq(clients.id, id)).returning()
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
