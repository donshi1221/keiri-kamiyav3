import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { monthlyRecords } from '@/lib/schema'
import { sendChatworkMessage } from '@/lib/chatwork'
import { getOrCreateInvoiceUploadToken } from '@/lib/invoice-token'
import { deliveryTargetMonth } from '@/lib/delivery-status'
import { INVOICE_REMINDER_TEMPLATE } from '@/lib/config'
import { parseBody, invoiceReminderSendSchema } from '@/lib/validation'
import type {
  InvoiceReminderPlan,
  InvoiceReminderTarget,
  InvoiceReminderSendResult,
} from '@/lib/ui-types'

// 請求書の未提出リマインド。押されたときだけ送る手動操作で、自動送信・定期送信は行わない
// （催促は相手のある行為なので、送る/送らないの判断を人の手に残す）。
// proxy.ts の既定の保護対象（/api/... は認証必須）に入るパスに置いている。

// 送信先候補1人分の内部表現。ルームIDは応答に含めず（画面に不要な識別子を出さない）、
// 有無だけを hasRoomId として返す。
interface ReminderCandidate {
  contractorId: string
  name: string
  roomId: string | null
}

// 表示中の月（＝支払月）で請求書が未受領の委託者を集める。
// 判定材料は monthly_records.invoice_received_at で、1件でも未受領の行があれば対象にする
// （複数クライアントを担当する委託者でも請求書は1通にまとめて届くため、人単位で1回だけ催促する）。
async function findCandidates(year: number, month: number): Promise<ReminderCandidate[]> {
  const rows = await db.query.monthlyRecords.findMany({
    where: and(eq(monthlyRecords.year, year), eq(monthlyRecords.month, month)),
    with: {
      assignments: {
        with: {
          contractors: { columns: { id: true, name: true, chatwork_room_id: true } },
        },
      },
    },
  })

  const byContractor = new Map<string, ReminderCandidate>()
  for (const r of rows) {
    if (r.invoice_received_at) continue
    // 終了したアサインの行が残っていても催促の理由にはならないため、稼働中のものだけ見る。
    if (!r.assignments?.active) continue
    const c = r.assignments.contractors
    if (!c || byContractor.has(c.id)) continue
    byContractor.set(c.id, { contractorId: c.id, name: c.name, roomId: c.chatwork_room_id })
  }

  return Array.from(byContractor.values()).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
}

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

    const candidates = await findCandidates(ym.year, ym.month)
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
    const candidates = await findCandidates(year, month)
    const requested = new Set(contractorIds)
    const targets = candidates.filter((c) => requested.has(c.contractorId))
    if (targets.length === 0) {
      return Response.json({ error: '送信できる対象がありません（すでに受領済みの可能性があります）。' }, { status: 400 })
    }

    const invoice = deliveryTargetMonth(year, month)
    // 受付URLはリクエストのオリジンから組み立てる（環境ごとにドメインが違うため固定値にしない）。
    const url = `${req.nextUrl.origin}/invoice/${await getOrCreateInvoiceUploadToken()}`

    // 相手ごとに独立した送信なので、1人が失敗しても残りは送る。
    // 同じ相手に二重送信しないよう、結果は必ず人単位で返す。
    const results: InvoiceReminderSendResult[] = []
    for (const t of targets) {
      if (!t.roomId) {
        results.push({
          contractorId: t.contractorId,
          name: t.name,
          status: 'no_room',
          message: 'ChatworkルームIDが未登録です（マスタ管理で登録してください）。',
        })
        continue
      }
      const body = template
        .replaceAll('{name}', t.name)
        .replaceAll('{month}', String(invoice.month))
        .replaceAll('{url}', url)
      const outcome = await sendChatworkMessage(t.roomId, body)
      if ('error' in outcome) {
        results.push({ contractorId: t.contractorId, name: t.name, status: 'error', message: outcome.error })
      } else if ('disabled' in outcome) {
        results.push({
          contractorId: t.contractorId,
          name: t.name,
          status: 'error',
          message: 'Chatwork連携が未設定です（CHATWORK_API_TOKEN を設定してください）。',
        })
      } else {
        results.push({ contractorId: t.contractorId, name: t.name, status: 'sent', message: null })
      }
    }

    return Response.json({ invoiceYear: invoice.year, invoiceMonth: invoice.month, results })
  } catch (err) {
    return serverError(err)
  }
}
