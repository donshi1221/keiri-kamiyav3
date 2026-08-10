import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { invoiceUploads } from '@/lib/schema'
import { checkInvoiceAndSave } from '@/lib/invoice-check'
import { cautionConfirmSchema, parseBody } from '@/lib/validation'

// 注意の確認はマスタや納品シートを読み直す再チェックを伴うため、既定より長めの実行時間を許可する。
export const maxDuration = 60

// 「[注意] …をご確認ください」の行を人が確認したときの消し込み（confirmed=false で取り消し）。
// 確認済みの事実は check_notes（再チェックのたびに作り直される）ではなく
// confirmed_cautions に貯め、続けて照合をやり直すことで注意行がその場でOK表示へ変わる。
export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]/confirm-caution'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(cautionConfirmSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })

    const [row] = await db
      .select({ confirmed_cautions: invoiceUploads.confirmed_cautions })
      .from(invoiceUploads)
      .where(eq(invoiceUploads.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    // Set で持ち回るのは、同じ注意を二度押ししても重複して貯まらないようにするため。
    const keys = new Set(row.confirmed_cautions ?? [])
    if (parsed.data.confirmed) keys.add(parsed.data.key)
    else keys.delete(parsed.data.key)

    await db
      .update(invoiceUploads)
      .set({ confirmed_cautions: [...keys] })
      .where(eq(invoiceUploads.id, id))

    // 判定理由は保存済みの文字列を画面が読むだけなので、ここで照合をやり直さないと表示が変わらない。
    const outcome = await checkInvoiceAndSave(id)
    if (!outcome) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(outcome)
  } catch (err) {
    return serverError(err)
  }
}
