import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { expenseUploads } from '@/lib/schema'
import { extractExpenseAndSave } from '@/lib/expense-extract'

// 関数のタイムアウト上限（秒）。外部AI（Gemini）にPDF・画像を渡して読み取るため既定では足りない。
// Vercel の仕様上リテラルで指定する。
export const maxDuration = 60

// 再読み取り。AI側の一時的な失敗（混雑・レート制限）で明細が1行も取れなかった受付を、
// 経理の確認画面から叩き直せるようにする（請求書チェックの再読み取りと同じ役割）。
// 認証は proxy.ts が担うため、このルートは社内からしか呼ばれない。
export async function POST(_req: NextRequest, ctx: RouteContext<'/api/expense-uploads/[id]/extract'>) {
  try {
    const { id } = await ctx.params

    const [row] = await db
      .select({
        status: expenseUploads.status,
        file_name: expenseUploads.file_name,
        file_data: expenseUploads.file_data,
        file_type: expenseUploads.file_type,
      })
      .from(expenseUploads)
      .where(eq(expenseUploads.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    // 読み取り直すと明細（expense_upload_items）を作り直すため、代表が行ごとに割り当てた
    // 区分・クライアント、および登録済みの控えがすべて消えてしまう。
    // まだ誰も割り当てていない draft のときだけ許し、それ以外は入口で止める。
    if (row.status !== 'draft') {
      return Response.json(
        { error: 'この経費ファイルは代表が送信済み（または処理済み）のため再読み取りできません。' },
        { status: 409 }
      )
    }

    const outcome = await extractExpenseAndSave(id, row.file_data, row.file_type, row.file_name)

    // 読み取れなかった理由は画面に出す必要があるため、失敗も200で内容として返す
    // （HTTPエラーにすると「通信に失敗しました」に丸められ、理由が伝わらない）。
    return Response.json(outcome)
  } catch (err) {
    return serverError(err)
  }
}
