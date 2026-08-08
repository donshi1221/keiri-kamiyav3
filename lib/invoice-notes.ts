// 判定理由（invoice_uploads.check_notes）の1行に付ける印の読み書き。
// 書くのはサーバー（lib/invoice-check）、読むのは画面（app/invoice-check）で、
// 照合本体は server-only のためクライアントから import できない。両者が同じ規則を使えるようここに置く。
import type { InvoiceNoteLine, InvoiceNoteMark } from './ui-types'

// 行頭に付ける表示ラベル。DBに保存される文字列そのものなので、
// 変更すると保存済みの行が「印なし」に落ちる。既存データを壊さないよう安易に変えない。
export const INVOICE_NOTE_MARKS: Record<InvoiceNoteMark, string> = {
  ok: 'OK',
  ng: 'NG',
  hold: '保留',
  received: '受領',
  fixed: '修正',
  saved: '保存',
  saveFailed: '保存失敗',
}

// 手動修正の記録文。PATCH後の再チェックで毎回同じ文言を出し、
// かつ「この行が手動修正の印か」を後から判定するためにも使うので1か所に置く。
export const INVOICE_MANUAL_EDIT_NOTE = '読み取り結果を手動修正して再チェックしました'

export function formatInvoiceNote(mark: InvoiceNoteMark, text: string): string {
  return `[${INVOICE_NOTE_MARKS[mark]}] ${text}`
}

const MARK_BY_LABEL = new Map<string, InvoiceNoteMark>(
  (Object.keys(INVOICE_NOTE_MARKS) as InvoiceNoteMark[]).map((mark) => [INVOICE_NOTE_MARKS[mark], mark])
)

const MARK_PATTERN = /^\[([^\]]+)\]\s*(.*)$/

// 印が読めない行（印を付ける前に保存された過去データ）は mark: null で返す。
// 画面側が中立表示に落とすことで、古い行も欠けずに出せる。
export function parseInvoiceNotes(notes: string | null): InvoiceNoteLine[] {
  if (!notes) return []
  return notes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line): InvoiceNoteLine => {
      const matched = MARK_PATTERN.exec(line)
      if (!matched) return { mark: null, text: line }
      const mark = MARK_BY_LABEL.get(matched[1])
      return mark ? { mark, text: matched[2] } : { mark: null, text: line }
    })
}

// 手動修正した事実は check_notes 以外に置き場がなく、再チェックのたびに notes は作り直される。
// 前回の notes から印を拾い直して引き継ぐために使う。
export function hasInvoiceNoteMark(notes: string | null, mark: InvoiceNoteMark): boolean {
  return parseInvoiceNotes(notes).some((line) => line.mark === mark)
}
