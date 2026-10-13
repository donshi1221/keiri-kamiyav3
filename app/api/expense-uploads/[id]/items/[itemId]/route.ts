import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { expenseUploads, expenseUploadItems } from '@/lib/schema'
import { expenseItemPatchSchema, parseBody } from '@/lib/validation'

// 経理が明細の「内容」を直す。登録のときに請求経費の摘要と立替明細の項目名へ写されるので、
// 直せるのは登録の前（割当中・送信済み）だけにする。登録後にここだけ変えると、写した先と食い違う。
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/expense-uploads/[id]/items/[itemId]'>
) {
  try {
    const { id, itemId } = await ctx.params
    const parsed = parseBody(expenseItemPatchSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })

    const [upload] = await db
      .select({ status: expenseUploads.status })
      .from(expenseUploads)
      .where(eq(expenseUploads.id, id))
    if (!upload) return Response.json({ error: 'Not found' }, { status: 404 })
    if (upload.status !== 'draft' && upload.status !== 'submitted') {
      return Response.json({ error: '登録済み・却下の経費は内容を変更できません。' }, { status: 409 })
    }

    // 受付IDも条件に入れ、別の受付の明細を指した呼び出しでは何も変わらないようにする。
    const [updated] = await db
      .update(expenseUploadItems)
      .set({ description: parsed.data.description })
      .where(and(eq(expenseUploadItems.id, itemId), eq(expenseUploadItems.upload_id, id)))
      .returning({ id: expenseUploadItems.id, description: expenseUploadItems.description })
    if (!updated) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(updated)
  } catch (err) {
    return serverError(err)
  }
}
