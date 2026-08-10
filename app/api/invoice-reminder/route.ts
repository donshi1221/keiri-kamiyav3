import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { getOrCreateInvoiceUploadToken } from '@/lib/invoice-token'
import { deliveryTargetMonth } from '@/lib/delivery-status'
import { INVOICE_REMINDER_TEMPLATE } from '@/lib/config'
import { findInvoiceReminderCandidates, sendInvoiceReminders } from '@/lib/invoice-reminder'
import { parseBody, invoiceReminderSendSchema } from '@/lib/validation'
import type { InvoiceReminderPlan, InvoiceReminderTarget } from '@/lib/ui-types'

// 請求書の未提出リマインドの手動送信（画面のボタン）。
// 対象者の抽出・文面の組み立て・送信そのものは lib/invoice-reminder に置き、
// 毎月10日の自動送信（app/api/cron/invoice-reminder）と同じ処理を共有する。
// proxy.ts の既定の保護対象（/api/... は認証必須）に入るパスに置いている。

function parseYearMonth(searchParams: URLSearchParams): { year: number; month: number } | null {
  const year = Number(searchParams.get('year'))
  const month = Number(searchParams.get('month'))
  if (
    !Number.isInteger(year) || year < 2000 || year > 2100 ||
    !Number.isInteger(month) || month < 1 || month > 12
  ) {
    return null
  }
  return { year, month }
}

export async function GET(req: NextRequest) {
  try {
    const ym = parseYearMonth(req.nextUrl.searchParams)
    if (!ym) return Response.json({ error: 'year / month の指定が不正です' }, { status: 400 })

    const candidates = await findInvoiceReminderCandidates(ym.year, ym.month)
    // 催促する請求書は「M-1月分」。全委託者「◯月分＝前月業務分」ルールのため、
    // 支払月Mの行に対応する請求書の対象月は前月になる（納品チェックと同じ月ずらし）。
    const invoice = deliveryTargetMonth(ym.year, ym.month)

    const targets: InvoiceReminderTarget[] = candidates.map((c) => ({
      contractorId: c.contractorId,
      name: c.name,
      hasRoomId: !!c.roomId,
    }))

    const plan: InvoiceReminderPlan = {
      year: ym.year,
      month: ym.month,
      invoiceYear: invoice.year,
      invoiceMonth: invoice.month,
      targets,
      // 受付URLは送信時にサーバーが埋める。画面には {url} のまま見せることで、
      // 文面を編集しても URL が壊れない（＝人がURLを触らずに済む）。
      template: INVOICE_REMINDER_TEMPLATE,
    }
    return Response.json(plan)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(invoiceReminderSendSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const { year, month, contractorIds, template } = parsed.data

    // 送信先は画面から来たIDをそのまま使わず、サーバー側でもう一度「未受領の委託者」を数え直して
    // その中から選ぶ。画面を開いたまま放置している間にチェックが付いた人へ催促を送らないため。
    const candidates = await findInvoiceReminderCandidates(year, month)
    const requested = new Set(contractorIds)
    const targets = candidates.filter((c) => requested.has(c.contractorId))
    if (targets.length === 0) {
      return Response.json({ error: '送信できる対象がありません（すでに受領済みの可能性があります）。' }, { status: 400 })
    }

    const invoice = deliveryTargetMonth(year, month)
    // 受付URLはリクエストのオリジンから組み立てる（環境ごとにドメインが違うため固定値にしない）。
    const url = `${req.nextUrl.origin}/invoice/${await getOrCreateInvoiceUploadToken()}`

    const results = await sendInvoiceReminders(targets, {
      template,
      invoiceMonth: invoice.month,
      url,
    })

    return Response.json({ invoiceYear: invoice.year, invoiceMonth: invoice.month, results })
  } catch (err) {
    return serverError(err)
  }
}
