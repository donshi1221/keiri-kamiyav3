import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { expenseUploads } from '@/lib/schema'

// 経理の最終判断（却下）。経費としては登録せず、記録だけ残す。
export async function POST(_req: NextRequest, ctx: RouteContext<'/api/expense-uploads/[id]/reject'>) {
  try {
    const { id } = await ctx.params

    const [upload] = await db
      .select({ id: expenseUploads.id, status: expenseUploads.status })
      .from(expenseUploads)
      .where(eq(expenseUploads.id, id))
    if (!upload) return Response.json({ error: 'Not found' }, { status: 404 })

    // 却下できるのは registered 以外すべて。draft（＝読み取りに失敗して代表が先へ進めていない受付）を
    // あえて含めているのは、対象外の書類や本当に読めないファイルを片付ける手段がないと、
    // 経理の一覧に永久に残り続けてしまうため。
    // 一方、登録済みを却下扱いにすると、作成済みの client_expenses が「却下されたはずの経費」として
    // 残り、請求額と画面の状態が食い違う。取り消しは経費側の行を消す操作として別に扱う。
    if (upload.status === 'registered') {
      return Response.json({ error: 'この経費ファイルはすでに登録済みのため却下できません。' }, { status: 409 })
    }

    await db
      .update(expenseUploads)
      .set({ status: 'rejected', reviewed_at: new Date().toISOString() })
      .where(eq(expenseUploads.id, id))

    return Response.json({ id, status: 'rejected' })
  } catch (err) {
    return serverError(err)
  }
}
