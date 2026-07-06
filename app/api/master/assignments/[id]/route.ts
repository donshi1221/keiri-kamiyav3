import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { assignments, monthlyRecords } from '@/lib/schema'
import { eq, sql } from 'drizzle-orm'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/master/assignments/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()

    if (body.contractor_id !== undefined || body.client_id !== undefined) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(monthlyRecords)
        .where(eq(monthlyRecords.assignment_id, id))

      if (Number(count) > 0) {
        return Response.json(
          { error: '月次記録が存在するため、委託者・クライアントの変更はできません。' },
          { status: 409 }
        )
      }
    }

    await db.update(assignments).set({
      contractor_id: body.contractor_id,
      client_id: body.client_id,
      role_name: body.role_name,
      contractor_payout_amount: body.contractor_payout_amount,
      spreadsheet_url: body.spreadsheet_url ?? null,
      active: body.active,
    }).where(eq(assignments.id, id))

    const data = await db.query.assignments.findFirst({
      where: (a, { eq: eqFn }) => eqFn(a.id, id),
      with: {
        contractors: { columns: { id: true, name: true, contractor_type: true } },
        clients: { columns: { id: true, name: true } },
      },
    })
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/master/assignments/[id]'>
) {
  try {
    const { id } = await ctx.params

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(monthlyRecords)
      .where(eq(monthlyRecords.assignment_id, id))

    if (Number(count) > 0) {
      return Response.json(
        { error: `${count}件の月次記録が存在します。`, hint: 'inactive' },
        { status: 409 }
      )
    }

    await db.delete(assignments).where(eq(assignments.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
