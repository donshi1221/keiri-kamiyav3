import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { paymentRequests } from '@/lib/schema'
import { extractPaymentAndSave } from '@/lib/payment-extract'
import { savePaymentRequestToDrive } from '@/lib/payment-drive'

// 関数のタイムアウト上限（秒）。外部AI（Gemini）にPDF・画像を渡して読み取り、
// 未保存ならドライブ保存もやり直すため既定では足りない。Vercel の仕様上リテラルで指定する。
export const maxDuration = 60

// 読み取りのやり直し。Gemini の混雑など一時的な失敗はサーバー側でも自動で数回試すが、
// それでも駄目だった分をここから人の判断で叩き直せるようにする。
// 振込依頼は明細を持たない（読み取り結果は同じ行の列を上書きするだけ）ので、
// 経費の再読み取りと違って割り当てが消える心配が無く、どの状態でもやり直せる。
export async function POST(_req: NextRequest, ctx: RouteContext<'/api/payment-requests/[id]/extract'>) {
  try {
    const { id } = await ctx.params

    const [row] = await db
      .select({
        file_name: paymentRequests.file_name,
        file_data: paymentRequests.file_data,
        file_type: paymentRequests.file_type,
        drive_file_id: paymentRequests.drive_file_id,
        created_at: paymentRequests.created_at,
      })
      .from(paymentRequests)
      .where(eq(paymentRequests.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    const outcome = await extractPaymentAndSave(id, row.file_data, row.file_type, row.file_name)

    // 受付時にドライブへ保存できていない分は、ここで一緒にやり直す。保存先の月は支払期日で決まるため、
    // 期日が読めるようになったこのタイミングが、正しいフォルダへ入れられる最初の機会になる。
    // 保存の失敗で再読み取りの結果まで捨てないよう、失敗はログに留める。
    if (!row.drive_file_id) {
      try {
        const saved = await savePaymentRequestToDrive(
          id,
          row.file_name,
          row.file_data,
          row.file_type,
          'error' in outcome ? null : outcome.due_date,
          row.created_at
        )
        if ('error' in saved) console.error('[payment-requests:extract:drive]', saved.error)
      } catch (err) {
        console.error('[payment-requests:extract:drive]', err)
      }
    }

    // 読み取れなかった理由は画面に出す必要があるため、失敗も200で内容として返す
    // （HTTPエラーにすると「通信に失敗しました」に丸められ、理由が伝わらない）。
    return Response.json(outcome)
  } catch (err) {
    return serverError(err)
  }
}
