import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clientBillingItems } from '@/lib/schema'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'
import { parseBody, billingItemCreateSchema } from '@/lib/validation'

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(billingItemCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data

    // 初回のみ（初期費用）は「請求月の1ヶ月だけ契約が有効」という形で実現している。
    // 請求月が無いと isBillingItemActiveForMonth が常に true になり毎月請求が立ち続けるため、必ず要求する。
    const oneTime = body.one_time ?? false
    if (oneTime && !body.contract_start) {
      return Response.json({ error: '初回のみの内訳には請求月が必要です。' }, { status: 400 })
    }

    const [data] = await db.insert(clientBillingItems).values({
      client_id: body.client_id,
      label: body.label?.trim() ?? '',
      billing_amount: body.billing_amount ?? 0,
      // 初回のみに動画の本数は無い。0以外だとクライアントの月本数合計が狂う。
      monthly_video_count: oneTime ? 0 : (body.monthly_video_count ?? 0),
      one_time: oneTime,
      contract_start: body.contract_start ?? null,
      // 初回のみ＝請求月の1ヶ月だけ有効。契約期間はこの値で判定されるため1に固定する。
      contract_months: oneTime ? 1 : (body.contract_months ?? null),
      active: body.active ?? true,
      sort_order: body.sort_order ?? 0,
    }).returning()

    // 追加した内訳が当月の契約期間内なら、当月の請求記録も生成しておく（冪等）。
    const today = nowJST()
    await generateMonthlyRecords(today.getFullYear(), today.getMonth() + 1)

    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
