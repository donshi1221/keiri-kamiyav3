import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { and, eq, lt, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { contractors, invoiceReplies, invoiceUploads } from '@/lib/schema'
import { sendChatworkMessage } from '@/lib/chatwork'
import { INVOICE_REPLY_SENDING_STALE_MS } from '@/lib/config'
import { parseBody, invoiceReplyActionSchema } from '@/lib/validation'
import type { InvoiceReply } from '@/lib/schema'
import type { InvoiceReplyInfo, InvoiceReplyState } from '@/lib/ui-types'

// Chatwork への送信（最長15秒で打ち切り）を待つため、同じ階層の他のルートと同じ長さを許可する。
export const maxDuration = 60

function toInfo(row: InvoiceReply): InvoiceReplyInfo {
  return {
    kind: row.kind,
    state: row.state,
    draft_body: row.draft_body,
    sent_body: row.sent_body,
    sent_at: row.sent_at,
  }
}

// 操作できなかった理由。条件付きの更新が空振りしたあとに今の状態を読み、状態ごとに伝える
// （「できませんでした」だけでは、送信済みなのか画面が古いだけなのかが分からない）。
const BLOCKED_MESSAGE: Record<InvoiceReplyState, string> = {
  draft: '下書きの状態です。画面を更新してからやり直してください。',
  sending: '送信処理中です。少し待ってから画面を更新してください。',
  sent: 'すでに送信済みです。',
  skipped: '「返信しない」になっています。下書きに戻してから操作してください。',
}

async function blockedResponse(uploadId: string): Promise<Response> {
  const [current] = await db
    .select({ state: invoiceReplies.state })
    .from(invoiceReplies)
    .where(eq(invoiceReplies.upload_id, uploadId))
  if (!current) return Response.json({ error: '返信の下書きがありません。' }, { status: 404 })
  return Response.json({ error: BLOCKED_MESSAGE[current.state] }, { status: 409 })
}

// 状態を from から to へ進める。読んでから書くのではなく「from のときだけ書く」1文にして、
// 同時に押された操作が両方通るのを防ぐ。
async function moveState(uploadId: string, from: InvoiceReplyState, to: InvoiceReplyState): Promise<Response> {
  const [updated] = await db
    .update(invoiceReplies)
    .set({ state: to, updated_at: new Date().toISOString() })
    .where(and(eq(invoiceReplies.upload_id, uploadId), eq(invoiceReplies.state, from)))
    .returning()
  if (!updated) return blockedResponse(uploadId)
  return Response.json({ reply: toInfo(updated) })
}

// 委託者への返信（チェック結果の連絡）の操作。
//   send   … 画面で確かめた（直した）文面を Chatwork で送る
//   skip   … この請求書には返信しないと決める
//   reopen … 「返信しない」を取り消して下書きに戻す
// 送信済みは相手に届いた事実なので、どの操作でも元に戻せない。
export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]/reply'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(invoiceReplyActionSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const input = parsed.data

    if (input.action === 'skip') return moveState(id, 'draft', 'skipped')
    if (input.action === 'reopen') return moveState(id, 'skipped', 'draft')

    const [target] = await db
      .select({ room_id: contractors.chatwork_room_id })
      .from(invoiceReplies)
      .innerJoin(invoiceUploads, eq(invoiceReplies.upload_id, invoiceUploads.id))
      .leftJoin(contractors, eq(invoiceUploads.contractor_id, contractors.id))
      .where(eq(invoiceReplies.upload_id, id))
    if (!target) return Response.json({ error: '返信の下書きがありません。' }, { status: 404 })
    const roomId = target.room_id?.trim()
    if (!roomId) return Response.json({ error: 'Chatwork の宛先が未登録です' }, { status: 400 })

    // 二重送信の歯止め。送る前に draft → sending へ進められた1回だけが送信に進む。
    // ボタンの連打や2つのタブからの同時操作でも、2回目は更新が空振りしてここで止まる。
    // sending のまま古くなった行（送信の途中で関数が落ちた）は、放っておくと永久に送れなくなるため
    // 一定時間を過ぎたら取り直せるようにする。
    const now = new Date()
    const staleBefore = new Date(now.getTime() - INVOICE_REPLY_SENDING_STALE_MS).toISOString()
    const [claimed] = await db
      .update(invoiceReplies)
      .set({ state: 'sending', updated_at: now.toISOString() })
      .where(
        and(
          eq(invoiceReplies.upload_id, id),
          or(
            eq(invoiceReplies.state, 'draft'),
            and(eq(invoiceReplies.state, 'sending'), lt(invoiceReplies.updated_at, staleBefore))
          )
        )
      )
      .returning({ id: invoiceReplies.id })
    if (!claimed) return blockedResponse(id)

    const outcome = await sendChatworkMessage(roomId, input.body)

    if (!('messageId' in outcome)) {
      // 送れていないので下書きに戻す（sending のままにすると、直してすぐ送り直すことができない）。
      await db
        .update(invoiceReplies)
        .set({ state: 'draft', updated_at: new Date().toISOString() })
        .where(and(eq(invoiceReplies.id, claimed.id), eq(invoiceReplies.state, 'sending')))
      if ('disabled' in outcome) {
        return Response.json(
          { error: 'Chatwork連携が未設定です（CHATWORK_API_TOKEN を設定してください）。' },
          { status: 503 }
        )
      }
      return Response.json({ error: outcome.error }, { status: 502 })
    }

    try {
      const sentAt = new Date().toISOString()
      // draft_body は書き換えない。自動で作った文面と実際に送った文面の両方を残すため。
      const [saved] = await db
        .update(invoiceReplies)
        .set({
          state: 'sent',
          sent_body: input.body,
          sent_at: sentAt,
          chatwork_message_id: outcome.messageId,
          updated_at: sentAt,
        })
        .where(eq(invoiceReplies.id, claimed.id))
        .returning()
      // 送信の最中に請求書ごと削除された場合。メッセージは届いているが、記録する行がもう無い。
      if (!saved) return Response.json({ error: '送信しましたが、請求書が削除されたため記録できませんでした。' }, { status: 404 })
      return Response.json({ reply: toInfo(saved) })
    } catch (err) {
      // メッセージは相手に届いている。ここで下書きに戻すと同じ文面をもう一度送らせてしまうため、
      // 状態は sending のまま残し、送り直さないよう伝える。
      console.error('[invoice-check:reply] sent but failed to save:', err)
      return Response.json(
        { error: 'Chatwork へは送信できましたが、記録の保存に失敗しました。送り直さず、Chatwork を確認してください。' },
        { status: 500 }
      )
    }
  } catch (err) {
    return serverError(err)
  }
}
