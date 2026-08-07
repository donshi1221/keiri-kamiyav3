import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { checkInvoiceAndSave } from '@/lib/invoice-check'

// 編集者の納品シート（外部）を読みにいく場合があるため、既定より長めの実行時間を許可する。
export const maxDuration = 60

// 照合だけのやり直し。保留の多くはマスタ側の未登録・納品未反映が原因で、
// PDFの内容は変わっていない。読み取り（AI呼び出し）を挟まずに判定だけ更新できるようにする。
export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]/recheck'>
) {
  try {
    const { id } = await ctx.params
    const outcome = await checkInvoiceAndSave(id)
    if (!outcome) return Response.json({ error: 'Not found' }, { status: 404 })
    // 照合しなかった理由（読み取り失敗）も画面に出す必要があるため、内容として200で返す。
    return Response.json(outcome)
  } catch (err) {
    return serverError(err)
  }
}
