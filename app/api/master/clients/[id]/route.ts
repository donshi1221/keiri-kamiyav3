import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clients, assignments, monthlyClientRecords } from '@/lib/schema'
import { eq, sql } from 'drizzle-orm'
import { parseBody, clientPatchSchema } from '@/lib/validation'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/clients/[id]'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(clientPatchSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const v = parsed.data

    // リクエストに含まれた項目だけを更新対象にする（undefined のキーは触らない）。
    // これをしないと、UIが一部の項目だけ送った場合に未送信の項目が null / 0 上書きで消える。
    const patch: Partial<typeof clients.$inferInsert> = {}
    if (v.name !== undefined) patch.name = v.name
    if (v.contact_person !== undefined) patch.contact_person = v.contact_person ?? null
    if (v.billing_amount !== undefined) patch.billing_amount = v.billing_amount
    if (v.contract_start !== undefined) patch.contract_start = v.contract_start ?? null
    if (v.contract_months !== undefined) patch.contract_months = v.contract_months
    if (v.notes !== undefined) patch.notes = v.notes ?? null

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    const [data] = await db.update(clients).set(patch).where(eq(clients.id, id)).returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
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

    // 月次レコードは client_id を NOT NULL の外部キーで参照するため、
    // 残ったまま削除するとDBの制約違反で生の500になる。事前に件数を確認して弾く。
    const [{ count: recordCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(monthlyClientRecords)
      .where(eq(monthlyClientRecords.client_id, id))

    if (Number(recordCount) > 0) {
      return Response.json(
        { error: `${recordCount}件の月次記録が存在するため削除できません。` },
        { status: 409 }
      )
    }

    await db.delete(clients).where(eq(clients.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err)
  }
}
