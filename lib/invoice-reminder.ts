import 'server-only'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/lib/db'
import { appSettings, monthlyRecords } from '@/lib/schema'
import { sendChatworkMessage } from '@/lib/chatwork'
import type { InvoiceReminderSendResult } from '@/lib/ui-types'

// 請求書未提出リマインドの中身（対象者の抽出・文面の組み立て・送信）。
// 手動送信（app/api/invoice-reminder）と自動送信（app/api/cron/invoice-reminder）の
// 両方から呼ぶ。催促の宛先や文面が経路によって変わると事故になるため、ここに1本化する。

// 送信先候補1人分の内部表現。ルームIDは画面には返さず（不要な識別子を出さない）、
// 有無だけを呼び出し側が hasRoomId として公開する。
export interface ReminderCandidate {
  contractorId: string
  name: string
  roomId: string | null
}

// 対象月（＝支払月M）で請求書が未受領の委託者を集める。
// 判定材料は monthly_records.invoice_received_at で、1件でも未受領の行があれば対象にする
// （複数クライアントを担当する委託者でも請求書は1通にまとめて届くため、人単位で1回だけ催促する）。
export async function findInvoiceReminderCandidates(
  year: number,
  month: number
): Promise<ReminderCandidate[]> {
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

export function buildInvoiceReminderBody(
  template: string,
  params: { name: string; month: number; url: string }
): string {
  return template
    .replaceAll('{name}', params.name)
    .replaceAll('{month}', String(params.month))
    .replaceAll('{url}', params.url)
}

// 候補へ順に送る。相手ごとに独立した送信なので、1人が失敗しても残りは送る。
// 同じ相手に二重送信しないよう、結果は必ず人単位で1件返す。
export async function sendInvoiceReminders(
  targets: ReminderCandidate[],
  opts: { template: string; invoiceMonth: number; url: string }
): Promise<InvoiceReminderSendResult[]> {
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
    const body = buildInvoiceReminderBody(opts.template, {
      name: t.name,
      month: opts.invoiceMonth,
      url: opts.url,
    })
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
  return results
}

// ─── 自動送信の冪等性 ─────────────────────────────
// cron が同じ日に複数回叩かれても催促を重ねて送らないよう、「送信済みの日付」を1件だけ記録する。
// 専用テーブルを足さず app_settings（アプリ全体で1つだけ持つ設定のkey-valueストア）に置くのは、
// 必要なのが「最後に自動送信した日」1個だけで、履歴を残す要件が無いため。
const AUTO_SENT_ON_KEY = 'invoice_reminder_auto_sent_on'

// 「今日の自動送信枠」を取りに行く。取れたら true（＝これから送ってよい）、
// すでに今日の日付が入っていれば false（＝今日はもう送った）。
// 読んでから書くと同時実行で二重に通り抜けるため、1本のUPDATEで「今日でなければ今日にする」を行い、
// 実際に書き換えられたか（returning が空でないか）で判定する。
export async function claimAutoReminderSlot(dateKey: string): Promise<boolean> {
  const claimed = await db
    .insert(appSettings)
    .values({ key: AUTO_SENT_ON_KEY, value: dateKey })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: dateKey, updated_at: new Date().toISOString() },
      setWhere: ne(appSettings.value, dateKey),
    })
    .returning({ value: appSettings.value })
  return claimed.length > 0
}

// 送信までたどり着けなかったとき（URL未設定など）に枠を返す。
// 取ったままにすると、設定を直して同じ日に叩き直しても「送信済み」と誤判定されるため。
export async function releaseAutoReminderSlot(dateKey: string): Promise<void> {
  try {
    await db.delete(appSettings).where(and(eq(appSettings.key, AUTO_SENT_ON_KEY), eq(appSettings.value, dateKey)))
  } catch (err) {
    console.error('[invoice-reminder] releaseAutoReminderSlot failed:', err)
  }
}
