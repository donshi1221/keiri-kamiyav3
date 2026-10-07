// 請求書チェックの結果から「人に送る文面」を組み立てる（委託者への返信の下書き・経理への通知メール）。
// AIは使わず、ひな形のプレースホルダを置き換えるだけにしている（同じ判定からは毎回同じ文面が出る）。
// DBにも外部にも触らない関数だけを置く。ひな形（lib/config）は引数で受け取り、ここでは読まない
// （文面の確認をDB・環境変数なしで行えるようにするため）。
import { INVOICE_NOTE_MARKS, parseInvoiceNotes } from './invoice-notes'
import type { InvoiceCheckStatus, InvoiceNgReason, InvoiceNoteMark, InvoiceReplyKind } from './ui-types'

export interface InvoiceReplyTemplates {
  ok: string
  ng: string
  // 対象月が分からないときに「{month}月分」の代わりに入れる言葉。
  unknownMonth: string
  reasons: Record<InvoiceNgReason['kind'], string>
}

function yen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`
}

// 1回の走査でまとめて置き換える。順番に replaceAll を重ねると、先に入れた値（クライアント名など）に
// たまたま含まれる「{url}」のような文字列まで次の置き換えで書き換わってしまうため。
// 知らない名前のプレースホルダはそのまま残す（ひな形の書き間違いに人が気づけるように）。
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key] : whole))
}

function reasonValues(reason: InvoiceNgReason): Record<string, string> {
  switch (reason.kind) {
    case 'total':
    case 'expense_amount':
      return {
        billed: yen(reason.billed),
        expected: yen(reason.expected),
        diff: yen(Math.abs(reason.billed - reason.expected)),
      }
    case 'client_count':
      // 本数は差を書かない。請求と納品の本数が並んでいれば足りる。
      return { client: reason.client, billed: String(reason.billed), expected: String(reason.expected) }
    case 'client_amount':
      return {
        client: reason.client,
        billed: reason.billed === null ? '金額不明' : yen(reason.billed),
        expected: yen(reason.expected),
        diff: reason.billed === null ? '不明' : yen(Math.abs(reason.billed - reason.expected)),
      }
    case 'client_missing':
      return { client: reason.client, expected: yen(reason.expected) }
    case 'expense_missing':
      return { expected: yen(reason.expected) }
    case 'expense_unregistered':
      return { billed: yen(reason.billed) }
    case 'addressee':
      return { actual: reason.actual, correct: reason.correct }
    case 'other':
      return { text: reason.text }
  }
}

// NGの理由を、相手に伝わる文の一覧にする（1件1文）。
export function buildInvoiceReplyReasons(
  reasons: InvoiceNgReason[],
  templates: InvoiceReplyTemplates['reasons']
): string[] {
  return reasons.map((reason) => fill(templates[reason.kind], reasonValues(reason)))
}

export interface InvoiceReplyParams {
  kind: InvoiceReplyKind
  name: string
  // 請求書の対象月。読み取れていなければ null。
  month: number | null
  amount: number | null
  // kind が ng のときだけ使う。
  reasons: InvoiceNgReason[]
  url: string
}

export function buildInvoiceReplyBody(params: InvoiceReplyParams, templates: InvoiceReplyTemplates): string {
  const template = params.kind === 'ok' ? templates.ok : templates.ng
  // 対象月が分からないまま置き換えると「月分」だけが残って意味が通らないため、言い回しごと差し替える。
  const withMonth =
    params.month === null ? template.replaceAll('{month}月分', () => templates.unknownMonth) : template
  return fill(withMonth, {
    name: params.name,
    month: params.month === null ? '' : String(params.month),
    amount: params.amount === null ? '' : params.amount.toLocaleString('ja-JP'),
    reasons: buildInvoiceReplyReasons(params.reasons, templates.reasons)
      .map((line) => `・${line}`)
      .join('\n'),
    url: params.url,
  }).trim()
}

// ─── 経理への通知メール ─────────────────────────────

const STATUS_LABEL: Record<InvoiceCheckStatus, string> = {
  pending: '未チェック',
  ok: 'OK',
  ng: 'NG',
  hold: '保留',
}

// メールに載せる判定理由。一致した項目や「何をしたか」の記録まで並べると、対応が要る行が埋もれるため、
// 人が見るべき印だけに絞る（画面の既定表示と同じ考え方）。
const MAIL_NOTE_MARKS: InvoiceNoteMark[] = ['ng', 'hold', 'caution', 'saveFailed']

export interface InvoiceNotificationParams {
  // 委託者名（特定できていれば）か、請求書から読み取った差出人。どちらも無ければ null。
  senderName: string | null
  fileName: string
  month: number | null
  amount: number | null
  status: InvoiceCheckStatus
  checkNotes: string | null
  extractError: string | null
  hasReplyDraft: boolean
  checkUrl: string
}

export function buildInvoiceNotificationMail(p: InvoiceNotificationParams): { subject: string; text: string } {
  const verdict = p.extractError ? '読み取り失敗' : STATUS_LABEL[p.status]
  const sender = p.senderName ?? '差出人不明'
  const month = p.month === null ? '対象月不明' : `${p.month}月分`
  const amount = p.amount === null ? '金額不明' : yen(p.amount)

  const reasons = parseInvoiceNotes(p.checkNotes)
    .filter((line) => line.mark === null || MAIL_NOTE_MARKS.includes(line.mark))
    .map((line) => (line.mark ? `・[${INVOICE_NOTE_MARKS[line.mark]}] ${line.text}` : `・${line.text}`))

  const detail = p.extractError
    ? ['読み取りエラー:', `・${p.extractError}`]
    : reasons.length > 0
      ? ['理由:', ...reasons]
      : ['理由: （指摘はありません）']

  return {
    subject: `[請求書] ${sender} ${month} ${amount} — ${verdict}`,
    text: [
      '請求書が届きました。',
      '',
      `判定: ${verdict}`,
      `差出人: ${sender}`,
      `対象月: ${month}`,
      `請求額: ${amount}`,
      `ファイル名: ${p.fileName}`,
      '',
      ...detail,
      '',
      `返信の下書き: ${p.hasReplyDraft ? 'あり（確認画面から内容を確かめて Chatwork で送れます）' : 'なし'}`,
      '',
      `確認はこちら: ${p.checkUrl}`,
    ].join('\n'),
  }
}
