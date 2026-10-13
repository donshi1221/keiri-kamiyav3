import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { clients, expenseUploads, expenseUploadItems } from '@/lib/schema'
import { expenseItemPatchSchema, parseBody } from '@/lib/validation'

// 経理が明細の内容・金額・区分・クライアントを直す。どれも登録のときに請求経費や立替明細へ写されるので、
// 直せるのは登録の前（割当中・送信済み）だけにする。登録後にここだけ変えると、写した先と食い違う。
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/expense-uploads/[id]/items/[itemId]'>
) {
  try {
    const { id, itemId } = await ctx.params
    const parsed = parseBody(expenseItemPatchSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const v = parsed.data

    const [upload] = await db
      .select({ status: expenseUploads.status })
      .from(expenseUploads)
      .where(eq(expenseUploads.id, id))
    if (!upload) return Response.json({ error: 'Not found' }, { status: 404 })
    if (upload.status !== 'draft' && upload.status !== 'submitted') {
      return Response.json({ error: '登録済み・却下の経費は変更できません。' }, { status: 409 })
    }

    // 受付IDも条件に入れ、別の受付の明細を指した呼び出しでは何も変わらないようにする。
    const itemWhere = and(eq(expenseUploadItems.id, itemId), eq(expenseUploadItems.upload_id, id))
    const [current] = await db
      .select({
        kind: expenseUploadItems.kind,
        registered_client_expense_id: expenseUploadItems.registered_client_expense_id,
      })
      .from(expenseUploadItems)
      .where(itemWhere)
    if (!current) return Response.json({ error: 'Not found' }, { status: 404 })

    const patch: Partial<typeof expenseUploadItems.$inferInsert> = {}
    if (v.description !== undefined) patch.description = v.description

    const changesMoney = v.amount !== undefined || v.kind !== undefined || v.client_id !== undefined
    // 登録が途中で失敗した受付は、請求経費を作り終えた行が「送信済み」のまま残る。
    // その行の金額や請求先を変えると、作った請求経費と食い違うため止める。
    if (changesMoney && current.registered_client_expense_id) {
      return Response.json(
        { error: 'この明細はすでに請求経費として登録済みのため、金額・区分・クライアントは変更できません。' },
        { status: 409 }
      )
    }
    if (v.amount !== undefined) patch.amount = v.amount

    const nextKind = v.kind ?? current.kind
    if (v.kind !== undefined) {
      patch.kind = v.kind
      // クライアントを持つのは請求する行だけ。他の区分に残すと、請求するのかどうかが後から読めなくなる。
      if (v.kind !== 'client_billed') patch.client_id = null
      // 立替精算に乗らない区分は支払方法も持たせない（受付の送信時と同じ扱い）。
      if (v.kind === 'excluded' || v.kind === 'other') patch.pay_method = null
    }
    if (v.client_id !== undefined) {
      if (nextKind !== 'client_billed') {
        return Response.json(
          { error: 'クライアントを選べるのは「クライアントに請求」の明細だけです。' },
          { status: 400 }
        )
      }
      if (v.client_id !== null) {
        const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, v.client_id))
        if (!client) return Response.json({ error: '指定されたクライアントが見つかりません。' }, { status: 400 })
      }
      patch.client_id = v.client_id
    }

    const [updated] = await db.update(expenseUploadItems).set(patch).where(itemWhere).returning()
    if (!updated) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(updated)
  } catch (err) {
    return serverError(err)
  }
}
