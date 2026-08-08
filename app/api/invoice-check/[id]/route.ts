import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { invoiceUploads } from '@/lib/schema'
import { checkInvoiceAndSave } from '@/lib/invoice-check'
import { parseBody, invoiceExtractedPatchSchema } from '@/lib/validation'
import { eq } from 'drizzle-orm'

// 保存後に照合まで続けて実行し、その中で編集者の納品シート（外部）を読みにいくことがある。
// recheck 側と同じ理由で既定より長い実行時間を許可する。
export const maxDuration = 60

// AIの読み取り結果を人が直す。読み間違いを直すたびにPDFをAIへ投げ直すのは
// 時間もコストもかかるうえ、同じ読み間違いを繰り返すことが多いため、値そのものを上書きできるようにする。
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(invoiceExtractedPatchSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const v = parsed.data

    const [updated] = await db
      .update(invoiceUploads)
      .set({
        extracted_amount: v.extracted_amount,
        extracted_issuer: v.extracted_issuer,
        extracted_addressee: v.extracted_addressee,
        extracted_year: v.extracted_year,
        extracted_month: v.extracted_month,
        // 読み取りに失敗した行を手入力で救済するルートでもある。
        // extract_error が残っていると照合が「先に再読み取りを」と言って止まるため、ここで消す。
        extract_error: null,
      })
      .where(eq(invoiceUploads.id, id))
      .returning({ id: invoiceUploads.id })
    if (!updated) return Response.json({ error: 'Not found' }, { status: 404 })

    // 直した値での判定を人が押し直さずに済むよう、保存と同じ操作で照合まで終わらせる。
    const check = await checkInvoiceAndSave(id, { manuallyEdited: true })
    return Response.json({ ok: true, check })
  } catch (err) {
    return serverError(err)
  }
}

// 受け付けた請求書の削除（テストデータの片付け用）。
// returning() でPDF本体まで返さないよう、idだけを取り出して存在確認に使う。
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]'>
) {
  try {
    const { id } = await ctx.params
    const [deleted] = await db
      .delete(invoiceUploads)
      .where(eq(invoiceUploads.id, id))
      .returning({ id: invoiceUploads.id })
    if (!deleted) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
