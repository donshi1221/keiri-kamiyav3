import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { contractors, assignments } from '@/lib/schema'
import { eq, sql } from 'drizzle-orm'
import { parseBody, contractorPatchSchema } from '@/lib/validation'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/contractors/[id]'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(contractorPatchSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const v = parsed.data

    // リクエストに含まれた項目だけを更新対象にする（undefined のキーは触らない）。
    // これをしないと、UIが一部の項目だけ送った場合に未送信の項目が null 上書きで消える。
    const patch: Partial<typeof contractors.$inferInsert> = {}
    if (v.name !== undefined) patch.name = v.name
    if (v.contractor_type !== undefined) patch.contractor_type = v.contractor_type
    if (v.unit_price !== undefined) patch.unit_price = v.unit_price
    if (v.email !== undefined) patch.email = v.email ?? null
    if (v.notes !== undefined) patch.notes = v.notes ?? null

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: '更新する項目がありません。' }, { status: 400 })
    }

    const [data] = await db.update(contractors).set(patch).where(eq(contractors.id, id)).returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/contractors/[id]'>
) {
  try {
    const { id } = await ctx.params

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(assignments)
      .where(eq(assignments.contractor_id, id))

    if (Number(count) > 0) {
      return Response.json(
        { error: `${count}件のアサインが存在するため削除できません。先にアサインを削除してください。` },
        { status: 409 }
      )
    }

    await db.delete(contractors).where(eq(contractors.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return serverError(err)
  }
}
