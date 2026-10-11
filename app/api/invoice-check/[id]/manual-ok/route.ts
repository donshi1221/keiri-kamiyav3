import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { invoiceUploads } from '@/lib/schema'
import { checkInvoiceAndSave } from '@/lib/invoice-check'
import { eq } from 'drizzle-orm'

// 照合をやり直すため、編集者の納品シート（外部）を読みにいく場合がある。recheck 側と同じ理由で長めに許可する。
export const maxDuration = 60

// 人が見てOKにする。金額を入れ直す手動OK（approve）と違い、支払額には触らず判定だけをOKにする。
// 支払い済みの過去分や、金額を別で調整済みの請求書は、自動照合では直しようのないNG・保留が残り続けるため。
export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]/manual-ok'>
) {
  try {
    const { id } = await ctx.params
    const [invoice] = await db
      .select({ status: invoiceUploads.status })
      .from(invoiceUploads)
      .where(eq(invoiceUploads.id, id))
    if (!invoice) return Response.json({ error: 'Not found' }, { status: 404 })
    // OKの行は上書きするものが無い。pending は照合自体がまだなので、人が見る材料が出ていない。
    if (invoice.status !== 'hold' && invoice.status !== 'ng') {
      return Response.json({ error: '保留またはNGの請求書だけがOKにできます' }, { status: 400 })
    }

    const outcome = await checkInvoiceAndSave(id, { trigger: 'manual_ok', origin: req.nextUrl.origin, manualOk: true })
    if (!outcome) return Response.json({ error: 'Not found' }, { status: 404 })
    // 照合しなかった理由（読み取り失敗）も画面に出す必要があるため、内容として200で返す。
    return Response.json(outcome)
  } catch (err) {
    return serverError(err)
  }
}

// 手動OKの取り消し。自動照合の結果（NG・保留）へ戻す。
export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]/manual-ok'>
) {
  try {
    const { id } = await ctx.params
    const outcome = await checkInvoiceAndSave(id, {
      trigger: 'manual_ok_cancel',
      origin: req.nextUrl.origin,
      manualOk: false,
    })
    if (!outcome) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(outcome)
  } catch (err) {
    return serverError(err)
  }
}
