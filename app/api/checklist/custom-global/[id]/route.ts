import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyCustomGlobalTasks } from '@/lib/schema'
import { eq } from 'drizzle-orm'

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/checklist/custom-global/[id]'>
) {
  try {
    const { id } = await ctx.params
    const body = await req.json()
    const yearMonth = body.yearMonth as number

    if (!yearMonth) {
      return Response.json({ error: 'yearMonth is required' }, { status: 400 })
    }

    const [current] = await db.select().from(monthlyCustomGlobalTasks).where(eq(monthlyCustomGlobalTasks.id, id))
    if (!current) return Response.json({ error: 'Not found' }, { status: 404 })

    const completedMonths: number[] = current.completed_months ?? []
    const newCompletedMonths = completedMonths.includes(yearMonth)
      ? completedMonths.filter((m) => m !== yearMonth)
      : [...completedMonths, yearMonth]

    const [data] = await db.update(monthlyCustomGlobalTasks)
      .set({ completed_months: newCompletedMonths })
      .where(eq(monthlyCustomGlobalTasks.id, id))
      .returning()

    return Response.json(data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/checklist/custom-global/[id]'>
) {
  try {
    const { id } = await ctx.params
    await db.delete(monthlyCustomGlobalTasks).where(eq(monthlyCustomGlobalTasks.id, id))
    return new Response(null, { status: 204 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
