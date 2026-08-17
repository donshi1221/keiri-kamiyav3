'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronRight, Plus, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { getLastDayOfMonth, getDueState, type DueState } from '@/lib/dates'
import type { CarryOverGroup } from '@/lib/carry-over'
import type { MonthlyGlobalTask, CustomGlobalTask, OneTimeTask, Expense, ClientExpense } from '@/lib/schema'
import type { RecordWithRelations, ClientRecordWithClient, TaskItem, DeliveryCheckRow, InvoiceAlertCounts, PayrollRecordWithRecipient } from '@/lib/ui-types'
import { DELIVERY_STATUS_LABEL, deliveryTone, deliveryTargetMonth, deliveryCacheKey, suggestedPayout } from '@/lib/delivery-status'
import { PAYROLL_KIND_LABEL, payrollAmountsOfRecord, payrollDeductions, payrollNet } from '@/lib/payroll'
import { PAYROLL_DEFAULT_PAY_DAY } from '@/lib/config'
import TodayTasks from './today-tasks'
import ErrorToast from './error-toast'
import InvoiceReminderDialog from './invoice-reminder-dialog'
import { FormDialog } from './form-dialog'

// Checkbox は見た目 16px のままだとスマホで押しづらいため、当たり判定用の after 疑似要素だけを
// 44×44px に広げる（16 + 14×2）。md 以上は shadcn 既定のコンパクトな判定に戻す。
const TAP_CHECKBOX = 'after:-inset-x-3.5 after:-inset-y-3.5 md:after:-inset-x-3 md:after:-inset-y-2'
// アイコンボタン（14px）用。同じく当たり判定だけを 46×46px に広げる。
const TAP_ICON_BUTTON = 'relative after:absolute after:-inset-4 md:after:hidden'
// 32px の丸ボタン用。丸の見た目を保ったまま判定だけ 44×44px にする（32 + 6×2）。
const TAP_ROUND_BUTTON = 'relative after:absolute after:-inset-1.5 md:after:hidden'

// 請求書チェックの注意カードに並べる区分。緊急度の高い順に固定し、0件の区分は表示時に落とす。
const INVOICE_ALERT_KINDS: { key: keyof InvoiceAlertCounts; label: string }[] = [
  { key: 'ng', label: 'NG' },
  { key: 'hold', label: '保留' },
  { key: 'pending', label: '未チェック' },
]

function rowDueState(states: DueState[]): DueState {
  if (states.includes('overdue')) return 'overdue'
  if (states.includes('inWindow')) return 'inWindow'
  return 'done'
}

function rowDueClass(state: DueState): string {
  if (state === 'overdue') return 'bg-danger-subtle/70 hover:bg-danger-subtle/70'
  if (state === 'inWindow') return 'bg-warning-subtle/70 hover:bg-warning-subtle/70'
  return 'hover:bg-accent'
}

// 相手（委託者・クライアント）そのものを表す行の背景。
// 対応色（オレンジ）は「対応が必要な内訳」の色として使うため、相手の行はまとまりの目印として
// 淡いブルー（secondary）で固定する。
// そうしないと、内訳が1件だけの相手が上の相手の内訳と地続きに見えて区切りが読めない。
// 期限超過だけは見落とすと支払い・入金の遅れに直結するため、例外的に面でも塗る。
function groupRowClass(state: DueState): string {
  if (state === 'overdue') return 'bg-danger-subtle/70 hover:bg-danger-subtle/70'
  return 'bg-secondary hover:bg-secondary'
}

// 相手の行の左端に出す期限バー。背景を塗らない代わりの目印。
// 期限が無い相手も透明の枠で同じ幅を取り、名前の開始位置がずれないようにする。
function groupAccentClass(state: DueState): string {
  if (state === 'overdue') return 'border-l-4 border-l-danger'
  if (state === 'inWindow') return 'border-l-4 border-l-warning'
  return 'border-l-4 border-l-transparent'
}

function DueBadge({ state }: { state: DueState }) {
  if (state === 'overdue') return <span className="block text-[10px] text-danger mt-1">期限超過</span>
  if (state === 'inWindow') return <span className="block text-[10px] text-warning mt-1">今週対応</span>
  return null
}

// 相手（委託者・クライアント）1件分の進み具合を、名前のすぐ近くで見せる点の並び。
// チェック欄は表の右端に離れて並ぶため、名前の列を上から追うだけでは進み具合が読み取れない。
// 状態そのものはチェックボックスが読み上げるので、ここは装飾として読み上げから外す（同じことを二度言わせない）。
function ProgressPips({ states, className = '' }: { states: boolean[]; className?: string }) {
  return (
    <span aria-hidden="true" className={`flex gap-1 ${className}`}>
      {states.map((done, i) => (
        <span key={i} className={`h-1.5 w-4 rounded-full ${done ? 'bg-primary' : 'bg-primary/20'}`} />
      ))}
    </span>
  )
}

// 回数契約（payment_count あり）のアサインだけ、契約更新の伺いが要るタイミングで出すバッジ。
// 継続契約（payment_count が null）は上限が無いので何も出さない。
function PaymentCountBadge({ paymentCount, paid }: { paymentCount: number | null; paid: number }) {
  if (paymentCount == null) return null
  if (paid > paymentCount) {
    return <span className="inline-block rounded bg-danger-subtle px-1.5 py-0.5 text-xs text-danger">契約回数 {paymentCount}回を超過</span>
  }
  if (paid === paymentCount) {
    return <span className="inline-block rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">契約回数 {paymentCount}回に到達</span>
  }
  if (paid === paymentCount - 1) {
    return <span className="inline-block rounded bg-warning-subtle px-1.5 py-0.5 text-xs text-warning">あと1回で契約回数 {paymentCount}回</span>
  }
  return null
}

// タスクのタイトルに直接書かれた URL（ChatWorkのリンク等）をタップできるようにする。
// split の捕捉グループ付き正規表現は「区切り文字＝奇数番目」で返るため、奇数だけリンクにする。
function renderTaskTitle(title: string): React.ReactNode[] {
  return title.split(/(https?:\/\/\S+)/g).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="underline text-info break-all">
        {part}
      </a>
    ) : (
      part
    )
  )
}

function formatShortDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// 指定した行までスクロールする。
// PC表とスマホカードは両方をDOMに出してCSSで出し分けているため、同じ data-pending-row が2つ存在する。
// 実際に表示されている方（offsetParent あり）を選ぶ。
function scrollToPendingRow(key: string) {
  const found = Array.from(document.querySelectorAll<HTMLElement>(`[data-pending-row="${key}"]`))
  const visible = found.find((el) => el.offsetParent !== null) ?? found[0]
  visible?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// 開閉できるセクションの見出し。1ヶ月分の明細は縦に長く、全部開いたままだと下のタスク欄まで
// 数画面スクロールが必要なため折りたためるようにしている。
// 閉じていても対応漏れに気づけるよう、金額・未完了件数・期限超過件数は見出しに常に出す。
function SectionHeader({ title, open, onToggle, amountLabel, amount, pending, overdue, action }: {
  title: string
  open: boolean
  onToggle: () => void
  amountLabel: string
  amount: number
  pending: number
  overdue: number
  action?: React.ReactNode
}) {
  return (
    // 閉じているときはヘッダーだけの箱になるため、余白を詰めて1行のバーに見えるようにする。
    <div className={`flex flex-wrap items-center justify-between gap-2 px-3 ${open ? 'border-b px-4 pt-3 pb-2' : 'py-1'}`}>
      <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-h-11 w-full items-center gap-2 rounded text-left hover:bg-accent md:min-h-7"
        >
          <ChevronRight size={16} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span>{title}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {amountLabel} ¥{amount.toLocaleString()} ・ {pending > 0 ? `未完了 ${pending}件` : 'すべて完了'}
            </span>
            {overdue > 0 && (
              <span className="rounded bg-danger-subtle px-1.5 py-0.5 text-xs font-normal text-danger">
                ⚠ 期限超過 {overdue}件
              </span>
            )}
          </span>
        </button>
      </h2>
      {action}
    </div>
  )
}

// 経費1件分の一覧＋追加フォーム。立替経費（委託者）と自社経費（クライアント）の両方で使う。
// 既定の文言は立替経費（委託者への支払いと、担当クライアントへの請求の両方に同額が乗る）向け。
// 自社経費は「委託者には払わない」＝意味が違うため、呼び出し側が文言を差し替えて誤解を防ぐ。
// 項目の型は Expense / ClientExpense のどちらでも通るよう、表示に使う列だけを要求する。
function ExpenseBlock({ items, formOpen, onOpenForm, onCloseForm, onAdd, onDelete, totalLabel = '経費 計', totalNote = '（請求にも同額を加算）', addLabel = '＋経費' }: {
  items: Pick<Expense, 'id' | 'expense_date' | 'amount' | 'note'>[]
  formOpen: boolean
  onOpenForm: () => void
  onCloseForm: () => void
  onAdd: (input: { expense_date: string; amount: string; note: string }) => void
  onDelete: (id: string) => void
  totalLabel?: string
  totalNote?: string
  addLabel?: string
}) {
  const [date, setDate] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  function submit() {
    if (!amount.trim()) return
    onAdd({ expense_date: date, amount, note })
    setDate(''); setAmount(''); setNote('')
  }

  const total = items.reduce((s, e) => s + e.amount, 0)

  return (
    <div className="mt-1 text-xs">
      {items.length > 0 && (
        <div className="space-y-0.5">
          {items.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
              <span className="text-muted-foreground">{e.expense_date ? formatShortDate(e.expense_date) : '日付なし'}</span>
              <span className="font-medium">¥{e.amount.toLocaleString()}</span>
              {e.note && <span className="text-muted-foreground">{e.note}</span>}
              <button
                type="button"
                onClick={() => onDelete(e.id)}
                aria-label="この経費を削除"
                className="flex h-11 items-center px-1 text-muted-foreground hover:text-danger md:h-5"
              >
                削除
              </button>
            </div>
          ))}
          <div className="text-muted-foreground">{totalLabel} ¥{total.toLocaleString()}{totalNote}</div>
        </div>
      )}
      {formOpen ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label="経費の日付"
            className="rounded border border-border px-1 py-1 text-xs"
          />
          <input
            type="number"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="金額"
            aria-label="経費の金額"
            className="w-20 rounded border border-border px-1 py-1 text-right text-xs [appearance:textfield] [-moz-appearance:textfield]"
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="内容（例: 打合せ往復）"
            aria-label="経費の内容"
            className="min-w-[8rem] flex-1 rounded border border-border px-1 py-1 text-xs"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!amount.trim()}
            className="flex h-11 items-center rounded border border-info/40 px-2 font-medium text-info hover:bg-info-subtle disabled:opacity-40 md:h-6"
          >
            追加
          </button>
          <button
            type="button"
            onClick={() => { setDate(''); setAmount(''); setNote(''); onCloseForm() }}
            className="flex h-11 items-center rounded px-2 text-muted-foreground hover:bg-accent md:h-6"
          >
            やめる
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpenForm}
          className="flex h-11 items-center text-info hover:underline md:h-5"
        >
          {addLabel}
        </button>
      )}
    </div>
  )
}

// 編集者1人分の納品チェック結果。「要確認」とだけ出すと原因が分からず調べようがないため、
// 理由のラベルと具体的な説明文（どのタブが無い・何の権限が足りない等）を必ず添える。
// 本数が揃っている場合だけ、実支払額（本数×単価）を反映するボタンを出す。
function DeliveryCheckNote({ row, unitPrice, currentAmount, onApply }: {
  row: DeliveryCheckRow
  unitPrice: number
  currentAmount: number | null
  onApply: (amount: number, videoCount: number) => void
}) {
  // 金額の上書きは戻せないため、既存の金額と食い違うときだけ確認ステップを挟む。
  const [confirming, setConfirming] = useState(false)
  const tone = deliveryTone(row)

  // 本数がずれている・確認が要るときは、その場でシートを開けるようにする。
  // タブを特定できていれば該当月のタブへ、できていなければシート本体へ飛ばす。
  const sheetHref = row.tabUrl ?? row.spreadsheetUrl
  const sheetLink = sheetHref && (
    <a
      href={sheetHref}
      target="_blank"
      rel="noopener noreferrer"
      className="flex h-11 items-center rounded px-1 font-medium text-info underline underline-offset-2 hover:bg-info-subtle md:h-6"
    >
      {row.tabTitle ? `${row.tabTitle.trim()}を開く` : 'シートを開く'}
    </a>
  )

  if (row.status !== 'ok') {
    const label = DELIVERY_STATUS_LABEL[row.status]
    // 対象月のタブが未作成なだけのケースは、設定不備と混ざらないよう控えめに出す。
    if (tone === 'none') {
      return <div className="text-xs text-muted-foreground">納品チェック: 対象なし（{label}）</div>
    }
    return (
      <div className="text-xs text-danger">
        <div className="flex flex-wrap items-center gap-x-2">
          <span>納品チェック: 要確認（{label}）</span>
          {sheetLink}
        </div>
        {row.message && <div className="text-muted-foreground">{row.message}</div>}
      </div>
    )
  }
  if (tone === 'none') {
    return <div className="text-xs text-muted-foreground">納品チェック: 対象なし</div>
  }

  const amount = suggestedPayout(row, unitPrice)
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs">
      <span className={tone === 'done' ? 'text-success' : 'text-warning'}>
        納品チェック: {row.delivered ?? 0}/{row.expected ?? 0}本
      </span>
      {/* 揃っていない月だけ、未記入の行を確かめられるようシートへの導線を出す。 */}
      {tone === 'short' && sheetLink}
      {tone === 'done' && unitPrice <= 0 && <span className="text-muted-foreground">単価未設定</span>}
      {amount !== null && amount === currentAmount && <span className="text-muted-foreground">金額反映済み</span>}
      {amount !== null && amount !== currentAmount && !confirming && (
        <button
          type="button"
          onClick={() => currentAmount === null ? onApply(amount, row.delivered ?? 0) : setConfirming(true)}
          className="flex h-11 items-center rounded border border-info/40 px-2 font-medium text-info hover:bg-info-subtle md:h-6"
        >
          ¥{amount.toLocaleString()} を反映
        </button>
      )}
      {amount !== null && confirming && (
        <span className="flex flex-wrap items-center gap-x-1">
          <span className="text-muted-foreground">¥{(currentAmount ?? 0).toLocaleString()} → ¥{amount.toLocaleString()} に上書き？</span>
          <button
            type="button"
            onClick={() => { onApply(amount, row.delivered ?? 0); setConfirming(false) }}
            className="flex h-11 items-center rounded px-2 font-medium text-danger hover:bg-danger-subtle md:h-6"
          >
            上書き
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="flex h-11 items-center rounded px-2 text-muted-foreground hover:bg-accent md:h-6"
          >
            戻る
          </button>
        </span>
      )}
    </div>
  )
}

// 委託者1件分の報酬額。代行者（editable）は月次の控え（payout_amount_snapshot）をその場で直せる。
// マスタの契約額を変えても既に生成された月の控えは変わらないため、途中で契約額が変わった月は
// この入力でしか直せない（マスタを直すと過去月まで遡って金額が変わってしまう）。
// 空欄で保存すると控えが外れ、表示・請求書照合ともマスタの契約額を使う状態に戻る。
// 見た目と操作は経費の追加フォーム（ExpenseBlock）に揃え、スマホでのタップ領域は44pxを確保する。
function PayoutAmountCell({ amount, editable, edited, strong, onSave }: {
  amount: number | null
  editable: boolean
  // 控えがマスタの契約額と食い違っている＝この月だけ手で直した状態。人が見て区別できるよう印を出す。
  edited: boolean
  // その相手の合計額として出す場合は太字にする。金額列を縦に見たとき
  // 「太字＝相手ごとの合計／細字＝その内訳」で階層が読めるようにするため。
  strong?: boolean
  onSave: (value: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const text = amount ? `¥${amount.toLocaleString()}` : '—'
  const toneClass = strong ? 'font-semibold text-foreground' : 'text-muted-foreground'

  async function submit() {
    setSaving(true)
    await onSave(value.trim())
    setSaving(false)
    setEditing(false)
  }

  // 編集者の報酬は納品チェックの「反映」で入るため、ここでは直接編集させない（二重の入口を作らない）。
  if (!editable) return <span className={toneClass}>{text}</span>

  if (editing) {
    return (
      <span className="flex flex-wrap items-center justify-end gap-1 text-xs">
        <input
          type="number"
          inputMode="numeric"
          min="0"
          value={value}
          autoFocus
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') setEditing(false)
          }}
          placeholder="空欄でマスタ額"
          aria-label="この月の報酬額"
          className="w-28 rounded border border-border px-1 py-1 text-right text-xs [appearance:textfield] [-moz-appearance:textfield]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="flex h-11 items-center rounded border border-info/40 px-2 font-medium text-info hover:bg-info-subtle disabled:opacity-40 md:h-6"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={saving}
          className="flex h-11 items-center rounded px-2 text-muted-foreground hover:bg-accent md:h-6"
        >
          やめる
        </button>
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      <button
        type="button"
        onClick={() => { setValue(amount === null ? '' : String(amount)); setEditing(true) }}
        aria-label="この月の報酬額を編集"
        className={`flex h-11 items-center rounded px-1 underline decoration-dotted underline-offset-4 hover:bg-accent md:h-6 ${toneClass}`}
      >
        {text}
      </button>
      {edited && (
        <span
          title="この月だけ金額を直した控えです（マスタの契約額とは異なります）"
          className="rounded bg-secondary px-1 py-0.5 text-[10px] text-muted-foreground"
        >
          控え
        </span>
      )}
    </span>
  )
}

// 金銭に関わるチェック用の操作部品。チェックを外すときだけ確認ステップを挟む（誤タップ防止）。
// タップ領域はスマホで44px以上を確保し、PCの表では詰めて表示する。
function MoneyCheckControl({ checked, checkedAt, pending, label, onRequest, onConfirm, onCancel, badge }: {
  checked: boolean
  checkedAt?: string | null
  pending: boolean
  label: string
  onRequest: () => void
  onConfirm: () => void
  onCancel: () => void
  badge?: React.ReactNode
}) {
  if (pending) {
    return (
      <div className="flex flex-col items-center gap-1">
        <span className="whitespace-nowrap text-[10px] text-muted-foreground">外しますか？</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onConfirm}
            className="flex h-11 min-w-11 items-center justify-center rounded px-2 text-xs font-medium text-danger hover:bg-danger-subtle md:h-6 md:min-w-0"
          >
            外す
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-11 min-w-11 items-center justify-center rounded px-2 text-xs text-muted-foreground hover:bg-accent md:h-6 md:min-w-0"
          >
            戻る
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={onRequest}
        aria-pressed={checked}
        aria-label={label}
        className="flex h-11 w-11 items-center justify-center md:h-auto md:w-auto"
      >
        <Checkbox checked={checked} className="pointer-events-none" tabIndex={-1} />
      </button>
      {checked && checkedAt && <span className="text-[10px] text-muted-foreground">{formatShortDate(checkedAt)}</span>}
      {badge}
    </div>
  )
}

// その月の役員報酬・給与の金額（控え）を直す小さなダイアログ。
// 保険料率や住民税は年の途中で改定されるため、マスタを直すと過去月まで遡って金額が変わってしまう。
// 改定のあった月だけをここで直せるようにして、過去の記録はそのまま残す。
const PAYROLL_FIELDS = [
  { key: 'gross_snapshot', label: '額面' },
  { key: 'health_insurance_snapshot', label: '健康保険' },
  { key: 'pension_snapshot', label: '厚生年金' },
  { key: 'employment_insurance_snapshot', label: '雇用保険' },
  { key: 'income_tax_snapshot', label: '源泉所得税' },
  { key: 'resident_tax_snapshot', label: '住民税' },
] as const
type PayrollField = (typeof PAYROLL_FIELDS)[number]['key']

function PayrollAmountsDialog({ record, monthLabel, onClose, onSave }: {
  record: PayrollRecordWithRecipient | null
  monthLabel: string
  onClose: () => void
  onSave: (id: string, values: Record<PayrollField, number>) => Promise<void>
}) {
  const [values, setValues] = useState<Record<PayrollField, string>>(() => ({
    gross_snapshot: '', health_insurance_snapshot: '', pension_snapshot: '',
    employment_insurance_snapshot: '', income_tax_snapshot: '', resident_tax_snapshot: '',
  }))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!record) return
    setValues({
      gross_snapshot: String(record.gross_snapshot),
      health_insurance_snapshot: String(record.health_insurance_snapshot),
      pension_snapshot: String(record.pension_snapshot),
      employment_insurance_snapshot: String(record.employment_insurance_snapshot),
      income_tax_snapshot: String(record.income_tax_snapshot),
      resident_tax_snapshot: String(record.resident_tax_snapshot),
    })
  }, [record])

  if (!record) return null

  const toNum = (v: string) => (v.trim() === '' ? 0 : Number(v))
  const preview = payrollNet({
    gross: toNum(values.gross_snapshot),
    health_insurance: toNum(values.health_insurance_snapshot),
    pension: toNum(values.pension_snapshot),
    employment_insurance: toNum(values.employment_insurance_snapshot),
    income_tax: toNum(values.income_tax_snapshot),
    resident_tax: toNum(values.resident_tax_snapshot),
  })

  async function submit() {
    if (!record) return
    setSaving(true)
    await onSave(record.id, {
      gross_snapshot: toNum(values.gross_snapshot),
      health_insurance_snapshot: toNum(values.health_insurance_snapshot),
      pension_snapshot: toNum(values.pension_snapshot),
      employment_insurance_snapshot: toNum(values.employment_insurance_snapshot),
      income_tax_snapshot: toNum(values.income_tax_snapshot),
      resident_tax_snapshot: toNum(values.resident_tax_snapshot),
    })
    setSaving(false)
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title={`${monthLabel}の金額を修正（${record.payroll_recipients?.name ?? '?'}）`}
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          この月の金額だけを直します（マスタの登録値と過去月の記録は変わりません）。
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PAYROLL_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="mb-1 block text-sm font-medium" htmlFor={`payroll-${f.key}`}>{f.label}</label>
              <input
                id={`payroll-${f.key}`}
                type="number"
                inputMode="numeric"
                min="0"
                value={values[f.key]}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                className="w-full rounded border border-border px-3 py-2 text-right text-sm"
              />
            </div>
          ))}
        </div>
        <div className="rounded border px-3 py-2 text-sm">
          振込額（手取り） <span className="font-semibold">¥{preview.toLocaleString()}</span>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" className="h-11 md:h-7" type="button" onClick={onClose}>キャンセル</Button>
          <Button size="sm" className="h-11 md:h-7" type="button" onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </FormDialog>
  )
}

interface Props {
  year: number
  month: number
  records: RecordWithRelations[]
  clientRecords: ClientRecordWithClient[]
  globalTask: MonthlyGlobalTask | null
  customTasks: CustomGlobalTask[]
  oneTimeTasks: OneTimeTask[]
  oneTimeWindowDays: number
  today: string
  billedCounts: Record<string, number>
  paidCounts: Record<string, number>
  assignmentPaymentCounts: Record<string, { scheduled: number; paid: number }>
  expenses: Expense[]
  // 自社が直接払った経費。委託者を経由しないためクライアントに直接ぶら下がる。
  clientExpenses: ClientExpense[]
  mfExpense: { amount: number; syncedAt: string } | null
  mfConnected: boolean
  mfExpired: boolean
  mfError: string | null
  mfJustConnected: boolean
  carryOver: CarryOverGroup[]
  // 対応が必要な請求書が1件も無ければ null（カードごと出さない）。
  invoiceAlert: InvoiceAlertCounts | null
  // 役員報酬・給与の当月分。対象者が未登録なら空配列（カードごと出さない）。
  payrollRecords: PayrollRecordWithRecipient[]
}

export default function DashboardClient({
  year, month, records, clientRecords, globalTask, customTasks: initialCustomTasks, oneTimeTasks: initialOneTimeTasks, oneTimeWindowDays, today, billedCounts, paidCounts, assignmentPaymentCounts, expenses: initialExpenses, clientExpenses: initialClientExpenses, mfExpense: initialMfExpense, mfConnected, mfExpired, mfError, mfJustConnected, carryOver, invoiceAlert, payrollRecords,
}: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const todayDate = new Date(today)
  const day = todayDate.getDate()
  const lastDay = getLastDayOfMonth(year, month)
  const isCurrentMonth =
    year === todayDate.getFullYear() && month === todayDate.getMonth() + 1
  const isPastMonth =
    year * 12 + month < todayDate.getFullYear() * 12 + (todayDate.getMonth() + 1)

  const [localRecords, setLocalRecords] = useState(records)
  const [localClientRecords, setLocalClientRecords] = useState(clientRecords)
  const [localExpenses, setLocalExpenses] = useState(initialExpenses)
  const [localClientExpenses, setLocalClientExpenses] = useState(initialClientExpenses)
  // 経費の入力フォームを開いているアサインID（1つずつ開く）。
  const [expenseFormFor, setExpenseFormFor] = useState<string | null>(null)
  // 自社経費の入力フォームを開いているクライアントID。立替経費とは紐づく相手が違うので別の状態で持つ。
  const [clientExpenseFormFor, setClientExpenseFormFor] = useState<string | null>(null)
  const [localPayrollRecords, setLocalPayrollRecords] = useState(payrollRecords)
  // 振込済みチェックを外すときの確認待ち（金銭に関わるチェックと同じ誤タップ防止）。
  const [pendingPayrollUncheck, setPendingPayrollUncheck] = useState<string | null>(null)
  const [payrollEditTarget, setPayrollEditTarget] = useState<PayrollRecordWithRecipient | null>(null)
  const [localGlobal, setLocalGlobal] = useState(globalTask)
  const [customTasks, setCustomTasks] = useState(initialCustomTasks)
  const [oneTimeTasks, setOneTimeTasks] = useState(initialOneTimeTasks)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDay, setNewDay] = useState('')
  // タスク種別: all=毎月 / specific=特定月のみ / single=単発。単発のみ due date を使う。
  const [monthMode, setMonthMode] = useState<'all' | 'specific' | 'single'>('all')
  const [selectedMonths, setSelectedMonths] = useState<number[]>([])
  const [newDueDate, setNewDueDate] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [pendingUncheck, setPendingUncheck] = useState<{ kind: 'record' | 'client'; id: string; field: string } | null>(null)
  // グループ一括（委託者の支払い確認／クライアントの入金確認）を外すときの確認待ち。
  const [pendingGroupUncheck, setPendingGroupUncheck] = useState<{ kind: 'contractor' | 'client'; ids: string[] } | null>(null)
  const [pendingGlobalUncheck, setPendingGlobalUncheck] = useState<string | null>(null)
  // 経費行（立替経費・自社経費）の送付チェックを外すときの確認待ち。クライアント単位で持つ。
  const [pendingExpenseUncheck, setPendingExpenseUncheck] = useState<{ kind: 'expense' | 'clientExpense'; clientId: string } | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [mfExpense, setMfExpense] = useState(initialMfExpense)
  const [isSyncing, setIsSyncing] = useState(false)
  const [snapshotConfirm, setSnapshotConfirm] = useState(false)
  const [snapshotBusy, setSnapshotBusy] = useState(false)
  const [deliveryRows, setDeliveryRows] = useState<DeliveryCheckRow[] | null>(null)
  const [deliveryLoading, setDeliveryLoading] = useState(false)
  const [reminderOpen, setReminderOpen] = useState(false)
  // 「この月の未完了」から飛んだ行を一時的に目立たせるためのキー（data-pending-row の値）。
  // 「今日やること」の名前チップは同一人物の複数行をまとめて指すため、複数キーを保持する。
  const [highlightKeys, setHighlightKeys] = useState<string[]>([])
  // 折りたたまれたセクションへ飛ぶときの飛び先。開く指示（setState）は即座にDOMへ反映されないため、
  // 行が描画されるまでスクロールを持ち越す入れ物として使う。
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)

  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const contractorSectionRef = useRef<HTMLElement | null>(null)
  const clientSectionRef = useRef<HTMLElement | null>(null)
  const globalTaskSectionRef = useRef<HTMLElement | null>(null)
  const summarySectionRef = useRef<HTMLElement | null>(null)

  // onOpen は折りたためるセクション用。閉じたまま飛ぶと中身が見えないため、飛ぶ前に開く。
  const jumpTargets: { label: string; ref: React.RefObject<HTMLElement | null>; onOpen?: () => void }[] = [
    { label: '委託者', ref: contractorSectionRef, onOpen: () => setContractorOpen(true) },
    { label: 'クライアント', ref: clientSectionRef, onOpen: () => setClientOpen(true) },
    { label: 'タスク', ref: globalTaskSectionRef },
    { label: 'サマリー', ref: summarySectionRef },
  ]

  function showError(msg: string) {
    setErrorMsg(msg)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => setErrorMsg(null), 4000)
  }

  // 該当行へスクロールして一時的にハイライトする。
  // 複数行をまとめて指す場合は、全行をハイライトしたうえで先頭の行までスクロールする
  // （まとめチップを押したときに「どの行が対象なのか」が曖昧にならないようにする）。
  // 飛び先のセクションが折りたたまれていると行が DOM に無いため、先に開いてから次の描画でスクロールする。
  function focusPendingRow(targets: string | string[]) {
    const keys = typeof targets === 'string' ? [targets] : targets
    if (keys.length === 0) return
    const key = keys[0]
    let deferred = false
    if ((key.startsWith('rec-') || key.startsWith('cgroup-')) && !contractorOpen) {
      setContractorOpen(true)
      deferred = true
    }
    if (key.startsWith('cli') && !clientOpen) {
      setClientOpen(true)
      deferred = true
    }
    if (deferred) setScrollTarget(key)
    else scrollToPendingRow(key)
    setHighlightKeys(keys)
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => setHighlightKeys([]), 1800)
  }

  // ハイライトは既存の行背景（期限色・グループ見出しの淡いブルー）と衝突するため、背景クラスごと差し替える。
  const rowBg = (target: string, base: string) =>
    highlightKeys.includes(target) ? 'bg-warning-subtle' : base

  // 支払いは前月納品分に対して行うため、チェック対象は表示中の月ではなく前月。
  const deliveryTarget = deliveryTargetMonth(year, month)

  // 納品チェック画面（/delivery）で実行した結果をそのまま引き継ぐ。
  // 画面を移動するたびに数え直すと、シートを人数分読むぶん待たされるため。
  useEffect(() => {
    const cached = sessionStorage.getItem(deliveryCacheKey(deliveryTarget.year, deliveryTarget.month))
    setDeliveryRows(cached ? (JSON.parse(cached) as DeliveryCheckRow[]) : null)
  }, [deliveryTarget.year, deliveryTarget.month])

  async function runDeliveryCheck() {
    setDeliveryLoading(true)
    try {
      const res = await fetch(
        `/api/delivery/check?year=${deliveryTarget.year}&month=${deliveryTarget.month}`,
        { cache: 'no-store' }
      )
      const data = (await res.json().catch(() => null)) as { rows?: DeliveryCheckRow[]; error?: string } | null
      if (!res.ok) throw new Error(data?.error ?? '編集者の納品チェックに失敗しました。')
      const rows = data?.rows ?? []
      setDeliveryRows(rows)
      sessionStorage.setItem(deliveryCacheKey(deliveryTarget.year, deliveryTarget.month), JSON.stringify(rows))
    } catch (err) {
      setDeliveryRows(null)
      showError(err instanceof Error ? err.message : '編集者の納品チェックに失敗しました。')
    } finally {
      setDeliveryLoading(false)
    }
  }

  function deliveryResult(assignmentId: string | undefined): DeliveryCheckRow | null {
    if (!assignmentId || !deliveryRows) return null
    return deliveryRows.find((row) => row.assignmentId === assignmentId) ?? null
  }

  // 納品チェックの結果から実支払額と支払対象本数を保存する。DBに入る値のため、押されたときだけ実行する。
  async function applyDeliveryPayout(recordId: string, amount: number, videoCount: number) {
    try {
      const res = await fetch(`/api/checklist/records/${recordId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: 'actual_payout_amount', value: String(amount), videoCount }),
      })
      if (!res.ok) throw new Error('save failed')
      const data = (await res.json()) as { actual_payout_amount: number | null; delivered_video_count: number | null }
      setLocalRecords((prev) =>
        prev.map((x) => x.id === recordId
          ? { ...x, actual_payout_amount: data.actual_payout_amount, delivered_video_count: data.delivered_video_count }
          : x)
      )
    } catch {
      showError('金額の保存に失敗しました。もう一度お試しください。')
    }
  }

  // 代行者の月次金額（控え）を直接書き換える。空文字は控えを外す＝マスタの契約額へ戻す指示。
  async function savePayoutSnapshot(recordId: string, value: string) {
    try {
      const res = await fetch(`/api/checklist/records/${recordId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: 'payout_amount_snapshot', value }),
      })
      if (!res.ok) throw new Error('save failed')
      const data = (await res.json()) as { payout_amount_snapshot: number | null }
      setLocalRecords((prev) =>
        prev.map((x) => x.id === recordId ? { ...x, payout_amount_snapshot: data.payout_amount_snapshot } : x)
      )
    } catch {
      showError('金額の保存に失敗しました。もう一度お試しください。')
    }
  }

  useEffect(() => () => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
  }, [])

  // MF連携コールバックの結果（?mf_error / ?mf_connected）を受け取り、失敗時は理由を通知する。
  // 表示後はクエリを消し、再読み込みで通知が再表示されないようにする。
  useEffect(() => {
    if (mfError) {
      showError('マネーフォワード連携に失敗しました。もう一度お試しください。')
      router.replace('/')
    } else if (mfJustConnected) {
      router.replace('/')
    }
    // 初回マウント時に一度だけ判定する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function navigate(delta: number) {
    if (delta > 0 && isCurrentMonth) return
    let y = year, m = month + delta
    if (m > 12) { m = 1; y++ }
    if (m < 1) { m = 12; y-- }
    startTransition(() => router.push(`/?year=${y}&month=${m}`))
  }

  // 過去月から当月へ一気に戻る。何ヶ月離れていても1回で戻れるよう、delta 指定の navigate は使わない。
  function goToCurrentMonth() {
    startTransition(() => router.push('/'))
  }

  async function toggleRecord(id: string, field: 'invoice_received_at' | 'payment_reserved_at' | 'contractor_paid_at') {
    // 失敗時に「この1件だけ」を直前の値へ戻せるよう、変更前の値を控える。
    const prevValue = localRecords.find((r) => r.id === id)?.[field] ?? null
    const nextChecked = !prevValue
    setLocalRecords((prev) => prev.map((r) => r.id === id ? { ...r, [field]: nextChecked ? new Date().toISOString() : null } : r))
    try {
      const res = await fetch(`/api/checklist/records/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, checked: nextChecked }),
      })
      if (!res.ok) throw new Error('save failed')
      const updated = await res.json()
      setLocalRecords((prev) => prev.map((r) => r.id === id ? { ...updated, assignments: r.assignments } : r))
    } catch {
      // 通信例外・保存失敗いずれの場合も、この行のこの項目だけを元に戻す（他の行の変更は保持）。
      setLocalRecords((prev) => prev.map((r) => r.id === id ? { ...r, [field]: prevValue } : r))
      showError('保存に失敗しました。もう一度お試しください。')
    }
  }

  async function toggleClientRecord(id: string, field: 'invoice_sent_at' | 'payment_confirmed_at') {
    const prevValue = localClientRecords.find((r) => r.id === id)?.[field] ?? null
    const nextChecked = !prevValue
    setLocalClientRecords((prev) => prev.map((r) => r.id === id ? { ...r, [field]: nextChecked ? new Date().toISOString() : null } : r))
    try {
      const res = await fetch(`/api/checklist/client-records/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, checked: nextChecked }),
      })
      if (!res.ok) throw new Error('save failed')
      const updated = await res.json()
      setLocalClientRecords((prev) => prev.map((r) => r.id === id ? { ...updated, clients: r.clients } : r))
    } catch {
      setLocalClientRecords((prev) => prev.map((r) => r.id === id ? { ...r, [field]: prevValue } : r))
      showError('保存に失敗しました。もう一度お試しください。')
    }
  }

  // 金銭に関わるチェックは「外す」操作のみ誤タップ防止の確認を挟む（付ける操作はそのまま）
  function requestToggleRecord(id: string, field: 'invoice_received_at' | 'payment_reserved_at' | 'contractor_paid_at', currentlyChecked: boolean) {
    if (currentlyChecked) {
      setPendingUncheck({ kind: 'record', id, field })
    } else {
      toggleRecord(id, field)
    }
  }

  function requestToggleClientRecord(id: string, field: 'invoice_sent_at' | 'payment_confirmed_at', currentlyChecked: boolean) {
    if (currentlyChecked) {
      setPendingUncheck({ kind: 'client', id, field })
    } else {
      toggleClientRecord(id, field)
    }
  }

  function confirmUncheck() {
    if (!pendingUncheck) return
    const { kind, id, field } = pendingUncheck
    setPendingUncheck(null)
    if (kind === 'record') {
      toggleRecord(id, field as 'invoice_received_at' | 'payment_reserved_at' | 'contractor_paid_at')
    } else {
      toggleClientRecord(id, field as 'invoice_sent_at' | 'payment_confirmed_at')
    }
  }

  function cancelUncheck() {
    setPendingUncheck(null)
  }

  // 委託者の「支払い確認」を、その委託者の全アサインに一括で反映する。
  // 支払いは委託者へまとめて行うため、行ごとでなく1操作で全行を揃える。
  async function bulkToggleContractorPaid(ids: string[], nextChecked: boolean) {
    const prev = new Map(ids.map((id) => [id, localRecords.find((r) => r.id === id)?.contractor_paid_at ?? null]))
    const stamp = new Date().toISOString()
    setLocalRecords((list) => list.map((r) => ids.includes(r.id) ? { ...r, contractor_paid_at: nextChecked ? stamp : null } : r))
    try {
      const results = await Promise.all(ids.map((id) =>
        fetch(`/api/checklist/records/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: 'contractor_paid_at', checked: nextChecked }),
        })
      ))
      if (results.some((res) => !res.ok)) throw new Error('save failed')
    } catch {
      // どれか失敗したら、この委託者分だけまとめて元に戻す（他の委託者の状態は保持）。
      setLocalRecords((list) => list.map((r) => ids.includes(r.id) ? { ...r, contractor_paid_at: prev.get(r.id) ?? null } : r))
      showError('保存に失敗しました。もう一度お試しください。')
    }
  }

  // クライアントの「入金確認」を、そのクライアントの全内訳に一括で反映する。
  async function bulkToggleClientConfirmed(ids: string[], nextChecked: boolean) {
    const prev = new Map(ids.map((id) => [id, localClientRecords.find((r) => r.id === id)?.payment_confirmed_at ?? null]))
    const stamp = new Date().toISOString()
    setLocalClientRecords((list) => list.map((r) => ids.includes(r.id) ? { ...r, payment_confirmed_at: nextChecked ? stamp : null } : r))
    try {
      const results = await Promise.all(ids.map((id) =>
        fetch(`/api/checklist/client-records/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: 'payment_confirmed_at', checked: nextChecked }),
        })
      ))
      if (results.some((res) => !res.ok)) throw new Error('save failed')
    } catch {
      setLocalClientRecords((list) => list.map((r) => ids.includes(r.id) ? { ...r, payment_confirmed_at: prev.get(r.id) ?? null } : r))
      showError('保存に失敗しました。もう一度お試しください。')
    }
  }

  // 一括チェック。付ける操作はそのまま、外す操作だけ確認を挟む（既存の誤タップ防止と同じ作法）。
  function requestBulkContractorPaid(ids: string[], currentlyAllChecked: boolean) {
    if (currentlyAllChecked) setPendingGroupUncheck({ kind: 'contractor', ids })
    else bulkToggleContractorPaid(ids, true)
  }
  function requestBulkClientConfirmed(ids: string[], currentlyAllChecked: boolean) {
    if (currentlyAllChecked) setPendingGroupUncheck({ kind: 'client', ids })
    else bulkToggleClientConfirmed(ids, true)
  }
  function confirmGroupUncheck() {
    if (!pendingGroupUncheck) return
    const { kind, ids } = pendingGroupUncheck
    setPendingGroupUncheck(null)
    if (kind === 'contractor') bulkToggleContractorPaid(ids, false)
    else bulkToggleClientConfirmed(ids, false)
  }

  // ─── 役員報酬・給与 ─────────────────────────────
  async function togglePayroll(id: string, nextChecked: boolean) {
    const prevValue = localPayrollRecords.find((r) => r.id === id)?.paid_at ?? null
    setLocalPayrollRecords((prev) => prev.map((r) => r.id === id ? { ...r, paid_at: nextChecked ? new Date().toISOString() : null } : r))
    try {
      const res = await fetch(`/api/checklist/payroll/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked: nextChecked }),
      })
      if (!res.ok) throw new Error('save failed')
      const updated = (await res.json()) as PayrollRecordWithRecipient
      // 対象者（マスタ）はAPIが返さないため、画面側の結合はそのまま引き継ぐ。
      setLocalPayrollRecords((prev) => prev.map((r) => r.id === id ? { ...updated, payroll_recipients: r.payroll_recipients } : r))
    } catch {
      setLocalPayrollRecords((prev) => prev.map((r) => r.id === id ? { ...r, paid_at: prevValue } : r))
      showError('保存に失敗しました。もう一度お試しください。')
    }
  }

  function requestTogglePayroll(id: string, currentlyChecked: boolean) {
    if (currentlyChecked) setPendingPayrollUncheck(id)
    else togglePayroll(id, true)
  }

  // その月の金額（控え）の書き換え。マスタと過去月には影響しない。
  async function savePayrollAmounts(id: string, values: Record<PayrollField, number>) {
    try {
      const res = await fetch(`/api/checklist/payroll/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      if (!res.ok) throw new Error('save failed')
      const updated = (await res.json()) as PayrollRecordWithRecipient
      setLocalPayrollRecords((prev) => prev.map((r) => r.id === id ? { ...updated, payroll_recipients: r.payroll_recipients } : r))
      setPayrollEditTarget(null)
    } catch {
      showError('金額の保存に失敗しました。もう一度お試しください。')
    }
  }

  async function toggleGlobal(field: 'expense_confirmed_at' | 'payment_report_confirmed_at' | 'withholding_confirmed_at') {
    if (!localGlobal) return
    const prevValue = localGlobal[field]
    const nextChecked = !prevValue
    setLocalGlobal((prev) => prev ? { ...prev, [field]: nextChecked ? new Date().toISOString() : null } : prev)
    try {
      const res = await fetch(`/api/checklist/global/${localGlobal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, checked: nextChecked }),
      })
      if (!res.ok) throw new Error('save failed')
      setLocalGlobal(await res.json())
    } catch {
      // このタスクのこの項目だけを元に戻す。
      setLocalGlobal((prev) => prev ? { ...prev, [field]: prevValue } : prev)
      showError('保存に失敗しました。もう一度お試しください。')
    }
  }

  // グローバルタスクも金銭チェックと同様、「外す」操作だけ誤タップ防止の確認を挟む。
  function requestToggleGlobal(field: 'expense_confirmed_at' | 'payment_report_confirmed_at' | 'withholding_confirmed_at', currentlyChecked: boolean) {
    if (currentlyChecked) {
      setPendingGlobalUncheck(field)
    } else {
      toggleGlobal(field)
    }
  }

  const yearMonth = year * 100 + month

  // 売上・外注費・利益の計算（マスタ改定後も過去月表示が変わらないよう、スナップショットを優先）
  // 立替経費は「委託者に払い、同額をクライアントに請求する」パススルーのため、
  // 売上・外注費の両方に同額を足す（結果として利益は増減しない）。
  // 自社経費は売上にだけ足す。コスト側に足さないのは、自社が直接払った支出は
  // マネーフォワードから取り込む経費（otherExpenses）に既に含まれており、ここで足すと二重計上になるため。
  // 売上に足すのは、クライアントへ請求する分だから。
  const expenseTotalAll = localExpenses.reduce((sum, e) => sum + e.amount, 0)
  const clientExpenseTotalAll = localClientExpenses.reduce((sum, e) => sum + e.amount, 0)
  const revenue = localClientRecords.reduce((sum, cr) => sum + (cr.billing_amount_snapshot ?? 0), 0) + expenseTotalAll + clientExpenseTotalAll
  const contractorCost = localRecords.reduce((sum, r) => {
    const asgn = r.assignments
    if (asgn?.contractors?.contractor_type === 'video_editor') {
      return sum + (r.actual_payout_amount ?? 0)
    }
    return sum + (r.payout_amount_snapshot ?? asgn?.contractor_payout_amount ?? 0)
  }, 0) + expenseTotalAll
  const otherExpenses = mfExpense?.amount ?? 0
  // 役員報酬・給与はここに含めない。このアプリの「利益」はクライアント請求から外注費を引いた粗利で、
  // 自社の人件費まで引くと今までの月と数字の意味が変わり、過去月との比較ができなくなるため。
  const profit = revenue - contractorCost - otherExpenses

  // ─── 役員報酬・給与の集計 ─────────────────────────────
  // 支払日が未登録なら既定日。31日など月末を超える指定は、その月の末日に丸めて判定する
  // （カスタムタスクの日にち指定と同じ扱い）。
  const payrollDueDay = (r: PayrollRecordWithRecipient): number =>
    Math.min(r.payroll_recipients?.pay_day ?? PAYROLL_DEFAULT_PAY_DAY, lastDay)
  const payrollDueState = (r: PayrollRecordWithRecipient): DueState =>
    isCurrentMonth ? getDueState(day, payrollDueDay(r), r.paid_at) : (r.paid_at ? 'done' : 'upcoming')
  // 源泉所得税は毎月まとめて納付するため、給与分の合計を1か所に出す（納付額を人が数え直さずに済む）。
  const payrollIncomeTaxTotal = localPayrollRecords.reduce((s, r) => s + r.income_tax_snapshot, 0)

  async function syncMFExpenses() {
    setIsSyncing(true)
    try {
      const res = await fetch('/api/moneyforward/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month }),
      })
      if (res.ok) {
        const data = await res.json()
        setMfExpense({ amount: data.amount, syncedAt: new Date().toISOString() })
      } else {
        const data = await res.json().catch(() => ({}))
        if (data.error === 'not_connected') {
          showError('マネーフォワードが未連携です。連携ボタンから認証してください。')
        } else {
          showError('MF経費の同期に失敗しました。もう一度お試しください。')
        }
      }
    } catch {
      showError('MF経費の同期に失敗しました。通信状況をご確認ください。')
    } finally {
      setIsSyncing(false)
    }
  }

  // 表示中の月のスナップショット欠損（生成漏れ等でnullの金額）を、現在のマスタ値で埋める。
  // 既存の値は上書きしない安全な補完（fill-missing）のみをUIから提供する。
  async function backfillSnapshots() {
    setSnapshotConfirm(false)
    setSnapshotBusy(true)
    try {
      const res = await fetch('/api/snapshots/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, mode: 'fill-missing' }),
      })
      if (!res.ok) throw new Error('backfill failed')
      // 補完結果を画面へ反映するため再取得する。
      startTransition(() => router.refresh())
    } catch {
      showError('スナップショットの補完に失敗しました。もう一度お試しください。')
    } finally {
      setSnapshotBusy(false)
    }
  }

  function resetAddForm() {
    setNewTitle('')
    setNewDay('')
    setSelectedMonths([])
    setNewDueDate('')
    setMonthMode('all')
    setShowAddForm(false)
  }

  async function addCustomTask() {
    if (!newTitle.trim()) return
    // 単発は別テーブル・別APIへ。繰り返し（毎月/特定月）とは処理を分ける。
    if (monthMode === 'single') { await addOneTimeTask(); return }
    if (monthMode === 'specific' && selectedMonths.length === 0) return
    if (isAdding) return
    setIsAdding(true)
    const months = monthMode === 'all' ? [] : selectedMonths
    // 表示用の日にち。1〜31以外・未入力は送らない（サーバ側で null になる）。
    const dayNum = Number(newDay)
    const day = Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 31 ? dayNum : null
    try {
      const res = await fetch('/api/checklist/custom-global', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim(), months, day }),
      })
      if (!res.ok) throw new Error('add failed')
      const created = await res.json()
      if (monthMode === 'all' || months.includes(month)) {
        setCustomTasks((prev) => [...prev, created])
      }
      resetAddForm()
    } catch {
      showError('タスクの追加に失敗しました。もう一度お試しください。')
    } finally {
      setIsAdding(false)
    }
  }

  async function addOneTimeTask() {
    if (!newTitle.trim() || !newDueDate) return
    if (isAdding) return
    setIsAdding(true)
    try {
      const res = await fetch('/api/checklist/one-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim(), due_date: newDueDate }),
      })
      if (!res.ok) throw new Error('add failed')
      const created: OneTimeTask = await res.json()
      // サーバの表示条件（期日の月が表示中の月以前）と同じ判定で、当月に出すべきものだけ追加する。
      const [dy, dm] = created.due_date.split('-').map(Number)
      if (dy * 100 + dm <= year * 100 + month) {
        setOneTimeTasks((prev) => [...prev, created])
      }
      resetAddForm()
    } catch {
      showError('タスクの追加に失敗しました。もう一度お試しください。')
    } finally {
      setIsAdding(false)
    }
  }

  async function toggleOneTimeTask(id: string) {
    const task = oneTimeTasks.find((t) => t.id === id)
    if (!task) return
    const nextCompleted = !task.completed_at
    const prev = task.completed_at
    // 楽観的更新: 完了時刻を即座に反映（失敗時は元へ戻す）。
    setOneTimeTasks((list) =>
      list.map((t) => (t.id === id ? { ...t, completed_at: nextCompleted ? today : null } : t))
    )
    try {
      const res = await fetch(`/api/checklist/one-time/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: nextCompleted }),
      })
      if (!res.ok) throw new Error('save failed')
    } catch {
      setOneTimeTasks((list) => list.map((t) => (t.id === id ? { ...t, completed_at: prev } : t)))
      showError('保存に失敗しました。もう一度お試しください。')
    }
  }

  async function deleteOneTimeTask(id: string) {
    setPendingDeleteId(null)
    const index = oneTimeTasks.findIndex((t) => t.id === id)
    const removed = oneTimeTasks[index]
    if (!removed) return
    setOneTimeTasks((prev) => prev.filter((t) => t.id !== id))
    try {
      const res = await fetch(`/api/checklist/one-time/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('delete failed')
    } catch {
      setOneTimeTasks((prev) => {
        const next = [...prev]
        next.splice(index, 0, removed)
        return next
      })
      showError('削除に失敗しました。もう一度お試しください。')
    }
  }

  async function toggleCustomTask(id: string) {
    const task = customTasks.find((t) => t.id === id)
    if (!task) return
    // 失敗時にこの1件だけ戻せるよう、変更前の完了月リストを控える。
    const prevCompletedMonths = task.completed_months
    const nextCompleted = !prevCompletedMonths.includes(yearMonth)
    setCustomTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, completed_months: nextCompleted ? [...t.completed_months, yearMonth] : t.completed_months.filter((m) => m !== yearMonth) }
          : t
      )
    )
    try {
      const res = await fetch(`/api/checklist/custom-global/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yearMonth, completed: nextCompleted }),
      })
      if (!res.ok) throw new Error('save failed')
    } catch {
      setCustomTasks((prev) => prev.map((t) => t.id === id ? { ...t, completed_months: prevCompletedMonths } : t))
      showError('保存に失敗しました。もう一度お試しください。')
    }
  }

  async function deleteCustomTask(id: string) {
    setPendingDeleteId(null)
    // 失敗時に削除した1件だけを元の位置へ復元できるよう、対象と位置を控える。
    const index = customTasks.findIndex((t) => t.id === id)
    const removed = customTasks[index]
    if (!removed) return
    setCustomTasks((prev) => prev.filter((t) => t.id !== id))
    try {
      const res = await fetch(`/api/checklist/custom-global/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('delete failed')
    } catch {
      setCustomTasks((prev) => {
        const next = [...prev]
        next.splice(index, 0, removed)
        return next
      })
      showError('削除に失敗しました。もう一度お試しください。')
    }
  }

  const globalTaskDefs = [
    { field: 'expense_confirmed_at' as const, label: '社長経費確認', dueLabel: '10日まで', dueDay: 10, windowDays: 5 },
    { field: 'payment_report_confirmed_at' as const, label: '支払・報酬 請求書チェック出し', dueLabel: '20日まで', dueDay: 20, windowDays: 3 },
    { field: 'withholding_confirmed_at' as const, label: '源泉所得税確認', dueLabel: '月末まで', dueDay: lastDay, windowDays: 4 },
  ]
  // 期日判定は「今日」基準なので、過去月にそのまま使うと未完了が「対応期間前」に見えてしまう。
  // ダッシュボードは当月までしか進めないため当月以外＝過去月とみなし、未完了は期限超過として出す。
  const visibleGlobalTasks = localGlobal
    ? globalTaskDefs.map((t) => ({
        ...t,
        state: isCurrentMonth
          ? getDueState(day, t.dueDay, localGlobal[t.field], t.windowDays)
          : ((localGlobal[t.field] ? 'done' : 'overdue') as DueState),
      }))
    : []

  // カスタムタスクの期日状態。日にち未設定は判定材料がないため null（バッジも「今日やること」も出さない）。
  // 過去月はグローバルタスクと同じく未完了＝期限超過。ただし作成前の月まで遡って期限超過にはしない。
  const customTaskState = (t: CustomGlobalTask): DueState | null => {
    if (t.completed_months.includes(yearMonth)) return 'done'
    if (t.day == null) return null
    // 31日など月末を超える指定は、その月の末日に丸めて判定する。
    if (isCurrentMonth) return getDueState(day, Math.min(t.day, lastDay), null, oneTimeWindowDays)
    if (!isPastMonth) return null
    const createdDate = new Date(t.created_at)
    const createdYearMonth = createdDate.getFullYear() * 100 + (createdDate.getMonth() + 1)
    return createdYearMonth > yearMonth ? null : 'overdue'
  }

  const clientDueState = (r: ClientRecordWithClient, field: 'invoice_sent_at' | 'payment_confirmed_at', dueDay: number): DueState =>
    isCurrentMonth ? getDueState(day, dueDay, r[field]) : (r[field] ? 'done' : 'upcoming')

  const recordDueState = (r: RecordWithRelations, field: 'invoice_received_at' | 'payment_reserved_at' | 'contractor_paid_at', dueDay: number): DueState =>
    isCurrentMonth ? getDueState(day, dueDay, r[field]) : (r[field] ? 'done' : 'upcoming')

  // クライアント請求記録を「クライアント単位」でグループ化する（1クライアントに複数の内訳がぶら下がる）。
  // created_at 順で内訳が飛び飛びに並んでも、同じクライアントの内訳が隣り合うようにまとめ直す。
  const clientGroups: { clientId: string; clientName: string; items: ClientRecordWithClient[] }[] = []
  const groupIndexByClient = new Map<string, number>()
  for (const cr of localClientRecords) {
    let idx = groupIndexByClient.get(cr.client_id)
    if (idx === undefined) {
      idx = clientGroups.length
      groupIndexByClient.set(cr.client_id, idx)
      clientGroups.push({ clientId: cr.client_id, clientName: cr.clients?.name ?? '?', items: [] })
    }
    clientGroups[idx].items.push(cr)
  }
  // 内訳名。生成時点の控え(label_snapshot)を優先し、無ければ内訳マスタの現在名。
  const itemLabel = (cr: ClientRecordWithClient): string =>
    (cr.label_snapshot ?? cr.billing_items?.label ?? '').trim()

  // 1レコード（アサイン）の報酬額。編集者は納品チェックで反映された実支払額、
  // 代行者はマスタの契約額（当月の控えを優先）。未確定は null。
  const recordPayout = (r: RecordWithRelations): number | null => {
    const isVE = r.assignments?.contractors?.contractor_type === 'video_editor'
    return isVE
      ? r.actual_payout_amount
      : (r.payout_amount_snapshot ?? r.assignments?.contractor_payout_amount ?? null)
  }

  // ─── 立替経費（代行者のみ）─────────────────────────────
  // アサインに紐づくため、委託者への支払いとクライアントへの請求の両方に同額が乗る（パススルー）。
  const expensesByAssignment = new Map<string, Expense[]>()
  for (const e of localExpenses) {
    expensesByAssignment.set(e.assignment_id, [...(expensesByAssignment.get(e.assignment_id) ?? []), e])
  }
  const expenseTotalOf = (assignmentId: string | undefined): number =>
    (assignmentId ? expensesByAssignment.get(assignmentId) ?? [] : []).reduce((s, e) => s + e.amount, 0)

  // クライアント側の集計用に、アサインID → クライアントID の対応を作る。
  const clientIdByAssignment = new Map<string, string>()
  for (const r of localRecords) {
    if (r.assignments) clientIdByAssignment.set(r.assignments.id, r.assignments.client_id)
  }
  const expensesOfClient = (clientId: string): Expense[] =>
    localExpenses.filter((e) => clientIdByAssignment.get(e.assignment_id) === clientId)

  // ─── 自社経費（クライアントのみ）─────────────────────────────
  // クライアントに直接紐づくため、委託者への支払いには乗らずクライアントへの請求にだけ加算される。
  const clientExpensesOf = (clientId: string): ClientExpense[] =>
    localClientExpenses.filter((e) => e.client_id === clientId)
  const clientExpenseTotalOf = (clientId: string): number =>
    clientExpensesOf(clientId).reduce((s, e) => s + e.amount, 0)

  // 内訳が複数、または立替経費・自社経費があるクライアントだけグループ見出し行を出している。
  // 入金確認のチェックは見出し側に集約されるため、未完了項目の飛び先もこの判定に合わせる。
  const clientHasGroupHeader = (clientId: string): boolean =>
    (clientGroups.find((g) => g.clientId === clientId)?.items.length ?? 0) > 1 ||
    expensesOfClient(clientId).reduce((s, e) => s + e.amount, 0) > 0 ||
    clientExpenseTotalOf(clientId) > 0

  // 経費は代行者にのみ紐づける運用のため、編集者のアサインには入力欄を出さない。
  const canAddExpense = (r: RecordWithRelations): boolean =>
    r.assignments?.contractors?.contractor_type !== 'video_editor'

  async function addExpense(assignmentId: string, input: { expense_date: string; amount: string; note: string }) {
    try {
      const res = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignment_id: assignmentId,
          year, month,
          expense_date: input.expense_date || null,
          amount: input.amount,
          note: input.note,
        }),
      })
      const data = (await res.json().catch(() => null)) as (Expense & { error?: string }) | null
      if (!res.ok) throw new Error(data?.error ?? '経費の追加に失敗しました。')
      if (data) setLocalExpenses((prev) => [...prev, data])
      setExpenseFormFor(null)
    } catch (err) {
      showError(err instanceof Error ? err.message : '経費の追加に失敗しました。')
    }
  }

  async function deleteExpense(id: string) {
    const prev = localExpenses
    setLocalExpenses((list) => list.filter((e) => e.id !== id))
    try {
      const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('delete failed')
    } catch {
      setLocalExpenses(prev)
      showError('経費の削除に失敗しました。もう一度お試しください。')
    }
  }

  async function addClientExpense(clientId: string, input: { expense_date: string; amount: string; note: string }) {
    try {
      const res = await fetch('/api/client-expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          year, month,
          expense_date: input.expense_date || null,
          amount: input.amount,
          note: input.note,
        }),
      })
      const data = (await res.json().catch(() => null)) as (ClientExpense & { error?: string }) | null
      if (!res.ok) throw new Error(data?.error ?? '自社経費の追加に失敗しました。')
      if (data) setLocalClientExpenses((prev) => [...prev, data])
      setClientExpenseFormFor(null)
    } catch (err) {
      showError(err instanceof Error ? err.message : '自社経費の追加に失敗しました。')
    }
  }

  // ─── 経費の請求書送付チェック ─────────────────────────────
  // 請求書はクライアント単位で1通のため、操作は行（そのクライアントの経費一覧）単位でまとめて行う。
  // 保存は経費1件ごとに持つ（後から経費を1件消しても、残りの送付記録が消えないようにするため）。
  async function toggleExpensesSent(kind: 'expense' | 'clientExpense', ids: string[], nextChecked: boolean) {
    const source: { id: string; invoice_sent_at: string | null }[] =
      kind === 'expense' ? localExpenses : localClientExpenses
    const prev = new Map(ids.map((id) => [id, source.find((e) => e.id === id)?.invoice_sent_at ?? null]))
    const stamp = nextChecked ? new Date().toISOString() : null
    const patch = <T extends { id: string; invoice_sent_at: string | null }>(list: T[], value: (id: string) => string | null): T[] =>
      list.map((e) => (ids.includes(e.id) ? { ...e, invoice_sent_at: value(e.id) } : e))
    if (kind === 'expense') setLocalExpenses((l) => patch(l, () => stamp))
    else setLocalClientExpenses((l) => patch(l, () => stamp))
    try {
      const base = kind === 'expense' ? '/api/expenses' : '/api/client-expenses'
      const results = await Promise.all(ids.map((id) =>
        fetch(`${base}/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checked: nextChecked }),
        })
      ))
      if (results.some((res) => !res.ok)) throw new Error('save failed')
    } catch {
      // どれか失敗したら、この行の分だけまとめて元へ戻す（他の行の変更は保持）。
      if (kind === 'expense') setLocalExpenses((l) => patch(l, (id) => prev.get(id) ?? null))
      else setLocalClientExpenses((l) => patch(l, (id) => prev.get(id) ?? null))
      showError('保存に失敗しました。もう一度お試しください。')
    }
  }

  function requestExpensesSent(kind: 'expense' | 'clientExpense', clientId: string, ids: string[], currentlyAllChecked: boolean) {
    if (currentlyAllChecked) setPendingExpenseUncheck({ kind, clientId })
    else toggleExpensesSent(kind, ids, true)
  }

  // 経費行の送付チェック。内訳の送付と同じ見た目・作法（外すときだけ確認／未チェックは期限バッジ）に揃える。
  const renderExpenseSentCheck = (
    kind: 'expense' | 'clientExpense',
    clientId: string,
    clientName: string,
    items: { id: string; invoice_sent_at: string | null }[]
  ) => {
    const ids = items.map((e) => e.id)
    const allSent = items.length > 0 && items.every((e) => !!e.invoice_sent_at)
    const sentAt = allSent
      ? items.reduce<string | null>((max, e) => (!max || (e.invoice_sent_at && e.invoice_sent_at > max) ? e.invoice_sent_at : max), null)
      : null
    const state: DueState = isCurrentMonth ? getDueState(day, 15, sentAt) : (allSent ? 'done' : 'upcoming')
    const rowLabel = kind === 'expense' ? '立替経費' : '自社経費'
    return (
      <MoneyCheckControl
        checked={allSent}
        checkedAt={sentAt}
        pending={pendingExpenseUncheck?.kind === kind && pendingExpenseUncheck.clientId === clientId}
        label={`${clientName}（${rowLabel}）の請求書送付`}
        onRequest={() => requestExpensesSent(kind, clientId, ids, allSent)}
        onConfirm={() => { setPendingExpenseUncheck(null); toggleExpensesSent(kind, ids, false) }}
        onCancel={() => setPendingExpenseUncheck(null)}
        badge={isCurrentMonth && !allSent && <DueBadge state={state} />}
      />
    )
  }

  async function deleteClientExpense(id: string) {
    const prev = localClientExpenses
    setLocalClientExpenses((list) => list.filter((e) => e.id !== id))
    try {
      const res = await fetch(`/api/client-expenses/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('delete failed')
    } catch {
      setLocalClientExpenses(prev)
      showError('自社経費の削除に失敗しました。もう一度お試しください。')
    }
  }

  // 委託者請求記録を「委託者単位」でグループ化する（1委託者が複数クライアントを担当しうる）。
  // クライアント側と同じく、created_at 順で飛び飛びに並んでも同じ委託者の行が隣り合うようまとめ直す。
  const contractorGroups: { contractorId: string; contractorName: string; items: RecordWithRelations[] }[] = []
  const groupIndexByContractor = new Map<string, number>()
  for (const r of localRecords) {
    const cid = r.assignments?.contractor_id ?? `__none__${r.id}`
    let idx = groupIndexByContractor.get(cid)
    if (idx === undefined) {
      idx = contractorGroups.length
      groupIndexByContractor.set(cid, idx)
      contractorGroups.push({ contractorId: cid, contractorName: r.assignments?.contractors?.name ?? '?', items: [] })
    }
    contractorGroups[idx].items.push(r)
  }

  // 支払い確認のチェックは、アサインが複数ある委託者ではグループ見出しに集約されている。
  // 未完了項目の飛び先も、行ではなくその見出しにする。
  const contractorPaidTarget = (r: RecordWithRelations): string => {
    const g = contractorGroups.find((x) => x.items.some((i) => i.id === r.id))
    return g && g.items.length > 1 ? `cgroup-${g.contractorId}` : `rec-${r.id}`
  }

  // 請求書が未受領の委託者の人数（Chatworkリマインドの対象になりうる人数）。
  // ローカル状態から数えることで、受領チェックを付けた瞬間にボタンが消える。
  // 対象はAPI側でも数え直すため、ここでの用途はボタンを出すかどうかの判断だけ。
  const unreceivedContractorCount = new Set(
    localRecords
      .filter((r) => !r.invoice_received_at && r.assignments?.active)
      .map((r) => r.assignments!.contractor_id)
  ).size

  // ─── セクション見出しの要約と開閉 ─────────────────────────
  // 未完了の数え方は「この月の未完了」に合わせる（支払い確認・入金確認は、複数アサイン／複数内訳では
  // 見出しのチェックに集約されていて操作が1回で済むため、1件と数える）。
  // 期日は表・カードの表示と同じ（受領10日 / 支払い予約15日 / 支払い確認 末日 / 送付15日 / 入金確認25日）。
  const contractorSummary = (() => {
    let pending = 0
    let overdue = 0
    for (const g of contractorGroups) {
      const multi = g.items.length > 1
      for (const r of g.items) {
        if (!r.invoice_received_at) {
          pending++
          if (recordDueState(r, 'invoice_received_at', 10) === 'overdue') overdue++
        }
        if (!r.payment_reserved_at) {
          pending++
          if (recordDueState(r, 'payment_reserved_at', 15) === 'overdue') overdue++
        }
        if (!multi && !r.contractor_paid_at) {
          pending++
          if (recordDueState(r, 'contractor_paid_at', lastDay) === 'overdue') overdue++
        }
      }
      if (multi && g.items.some((r) => !r.contractor_paid_at)) {
        pending++
        if (g.items.some((r) => recordDueState(r, 'contractor_paid_at', lastDay) === 'overdue')) overdue++
      }
    }
    return { pending, overdue }
  })()

  const clientSummary = (() => {
    let pending = 0
    let overdue = 0
    for (const g of clientGroups) {
      const grouped = clientHasGroupHeader(g.clientId)
      for (const cr of g.items) {
        if (!cr.invoice_sent_at) {
          pending++
          if (clientDueState(cr, 'invoice_sent_at', 15) === 'overdue') overdue++
        }
        if (!grouped && !cr.payment_confirmed_at) {
          pending++
          if (clientDueState(cr, 'payment_confirmed_at', 25) === 'overdue') overdue++
        }
      }
      if (grouped && g.items.some((cr) => !cr.payment_confirmed_at)) {
        pending++
        if (g.items.some((cr) => clientDueState(cr, 'payment_confirmed_at', 25) === 'overdue')) overdue++
      }
    }
    return { pending, overdue }
  })()

  // 既定は閉じる。ただし放置すると困る状態（当月＝期限超過あり／過去月＝未完了が残っている）の
  // セクションだけは開いた状態で出す。以後は手動の開閉を優先する（初期値なので再計算では変わらない）。
  const [contractorOpen, setContractorOpen] = useState(
    isCurrentMonth ? contractorSummary.overdue > 0 : contractorSummary.pending > 0
  )
  const [clientOpen, setClientOpen] = useState(
    isCurrentMonth ? clientSummary.overdue > 0 : clientSummary.pending > 0
  )

  // 折りたたみを開いた直後に、行が描画されてからスクロールする。
  useEffect(() => {
    if (!scrollTarget) return
    scrollToPendingRow(scrollTarget)
    setScrollTarget(null)
  }, [scrollTarget])

  // 単発タスクの期日判定（日付のみで比較）。'YYYY-MM-DD' 文字列は辞書順＝日付順なので直接比較できる。
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const todayYmd = `${todayDate.getFullYear()}-${pad2(todayDate.getMonth() + 1)}-${pad2(todayDate.getDate())}`
  const windowEndDate = new Date(todayDate)
  windowEndDate.setDate(windowEndDate.getDate() + oneTimeWindowDays)
  const windowEndYmd = `${windowEndDate.getFullYear()}-${pad2(windowEndDate.getMonth() + 1)}-${pad2(windowEndDate.getDate())}`
  const oneTimeDueState = (due: string): 'overdue' | 'inWindow' | 'upcoming' => {
    if (due < todayYmd) return 'overdue'
    if (due <= windowEndYmd) return 'inWindow'
    return 'upcoming'
  }
  // 期日 'YYYY-MM-DD' を「M/D」表示に。
  const formatDueMd = (due: string): string => {
    const [, m, d] = due.split('-').map(Number)
    return `${m}/${d}`
  }

  const overdueItems: TaskItem[] = []
  const inWindowItems: TaskItem[] = []
  if (isCurrentMonth) {
    for (const t of visibleGlobalTasks) {
      if (t.state === 'overdue') overdueItems.push({ label: `${t.label}`, target: 'global-tasks' })
      else if (t.state === 'inWindow') inWindowItems.push({ label: `${t.label}`, target: 'global-tasks' })
    }
    for (const cr of localClientRecords) {
      const baseName = cr.clients?.name ?? '?'
      // 同じクライアントに内訳が複数ある場合は「クライアント / 内訳名」で区別する。
      const isMulti = (clientGroups.find((g) => g.clientId === cr.client_id)?.items.length ?? 0) > 1
      const label = itemLabel(cr)
      const name = isMulti && label ? `${baseName} / ${label}` : baseName
      // クライアント系は件数が多くなるため group を付け、「今日やること」側でグループ折りたたみ表示にする。
      // グループ見出しに作業名（請求書送付/入金確認）が出るので、項目ラベルは名前だけにする。
      const sentTarget = `cli-${cr.id}`
      const confirmedTarget = clientHasGroupHeader(cr.client_id) ? `cligroup-${cr.client_id}` : `cli-${cr.id}`
      const sentState = clientDueState(cr, 'invoice_sent_at', 15)
      if (sentState === 'overdue') overdueItems.push({ label: name, group: 'clientInvoice', target: sentTarget })
      else if (sentState === 'inWindow') inWindowItems.push({ label: name, group: 'clientInvoice', target: sentTarget })
      // 入金確認のチェックがグループ見出しに集約されているクライアントは、内訳ごとに分けても
      // 飛び先も操作も同じ1つなので、クライアント名だけのラベルにして1チップにまとめる。
      const confirmedLabel = clientHasGroupHeader(cr.client_id) ? baseName : name
      const confirmedState = clientDueState(cr, 'payment_confirmed_at', 25)
      if (confirmedState === 'overdue') overdueItems.push({ label: confirmedLabel, group: 'clientPayment', target: confirmedTarget })
      else if (confirmedState === 'inWindow') inWindowItems.push({ label: confirmedLabel, group: 'clientPayment', target: confirmedTarget })
    }
    for (const r of localRecords) {
      const name = r.assignments?.contractors?.name ?? '?'
      const rowTarget = `rec-${r.id}`
      const paidTarget = contractorPaidTarget(r)
      // 委託者系も作業ごとの group にまとめる（グループ見出しに作業名が出るのでラベルは名前だけ）。
      // 同じ委託者でもアサインの数だけレコードがあるため、まとめないと同名の行が縦に並んでしまう。
      const receivedState = recordDueState(r, 'invoice_received_at', 10)
      if (receivedState === 'overdue') overdueItems.push({ label: name, group: 'contractorInvoice', target: rowTarget })
      else if (receivedState === 'inWindow') inWindowItems.push({ label: name, group: 'contractorInvoice', target: rowTarget })
      const reservedState = recordDueState(r, 'payment_reserved_at', 15)
      if (reservedState === 'overdue') overdueItems.push({ label: name, group: 'contractorReserve', target: rowTarget })
      else if (reservedState === 'inWindow') inWindowItems.push({ label: name, group: 'contractorReserve', target: rowTarget })
      const paidState = recordDueState(r, 'contractor_paid_at', lastDay)
      if (paidState === 'overdue') overdueItems.push({ label: name, group: 'contractorPaid', target: paidTarget })
      else if (paidState === 'inWindow') inWindowItems.push({ label: name, group: 'contractorPaid', target: paidTarget })
    }
    // 役員報酬・給与の振込。支払日は人ごとに違うため、行ごとに期日を見る。
    for (const p of localPayrollRecords) {
      const st = payrollDueState(p)
      const label = `${PAYROLL_KIND_LABEL[p.payroll_recipients?.kind ?? 'employee']}振込：${p.payroll_recipients?.name ?? '?'}`
      if (st === 'overdue') overdueItems.push({ label, target: `payroll-${p.id}` })
      else if (st === 'inWindow') inWindowItems.push({ label, target: `payroll-${p.id}` })
    }
    // 単発タスク: 期日超過なら「期限超過」、期日が近い（既定3日以内）なら「対応期間中」に載せる。
    for (const t of oneTimeTasks) {
      if (t.completed_at) continue
      const st = oneTimeDueState(t.due_date)
      const label = `${t.title}（${formatDueMd(t.due_date)}）`
      if (st === 'overdue') overdueItems.push({ label, target: 'global-tasks' })
      else if (st === 'inWindow') inWindowItems.push({ label, target: 'global-tasks' })
    }
    // カスタムタスク（毎月／特定月）: 日にち指定があるものだけ、単発タスクと同じ基準で載せる。
    for (const t of customTasks) {
      const st = customTaskState(t)
      const label = `${t.title}（${t.day}日）`
      if (st === 'overdue') overdueItems.push({ label, target: 'global-tasks' })
      else if (st === 'inWindow') inWindowItems.push({ label, target: 'global-tasks' })
    }
  }

  // この月にチェックすべき項目を、完了・未完了をまとめて1つの並びとして組み立てる。
  // 「この月の未完了」パネルと「進行度 X/Y」で数え方がずれると、同じ画面の2箇所が違うことを言い出すため、
  // 数える規則はここ1箇所に置く。
  // 支払い確認・入金確認は、複数アサイン／複数内訳ではチェックが見出しに集約されて操作が1回で済むので、
  // まとめて1件として数える。判定はローカル状態から行い、チェックを付けた瞬間に反映されるようにする。
  const monthChecks: { key: string; target: string; label: string; done: boolean }[] = []
  for (const g of contractorGroups) {
    const multi = g.items.length > 1
    for (const r of g.items) {
      const who = `${g.contractorName}（${r.assignments?.clients?.name ?? '?'}）`
      monthChecks.push({ key: `received-${r.id}`, target: `rec-${r.id}`, label: `請求書受領：${who}`, done: !!r.invoice_received_at })
      monthChecks.push({ key: `reserved-${r.id}`, target: `rec-${r.id}`, label: `支払い予約：${who}`, done: !!r.payment_reserved_at })
      // 支払い確認は複数アサインの委託者だとグループ見出しのチェックに集約されているため、行単位では出さない。
      if (!multi) monthChecks.push({ key: `paid-${r.id}`, target: `rec-${r.id}`, label: `支払い確認：${who}`, done: !!r.contractor_paid_at })
    }
    if (multi) {
      monthChecks.push({
        key: `paid-group-${g.contractorId}`,
        target: `cgroup-${g.contractorId}`,
        label: `支払い確認：${g.contractorName}`,
        done: g.items.every((r) => !!r.contractor_paid_at),
      })
    }
  }
  for (const g of clientGroups) {
    const multi = clientHasGroupHeader(g.clientId)
    for (const cr of g.items) {
      const label = itemLabel(cr)
      const who = multi && label ? `${g.clientName} / ${label}` : g.clientName
      monthChecks.push({ key: `sent-${cr.id}`, target: `cli-${cr.id}`, label: `請求書送付：${who}`, done: !!cr.invoice_sent_at })
      if (!multi) monthChecks.push({ key: `confirmed-${cr.id}`, target: `cli-${cr.id}`, label: `入金確認：${g.clientName}`, done: !!cr.payment_confirmed_at })
    }
    if (multi) {
      monthChecks.push({
        key: `confirmed-group-${g.clientId}`,
        target: `cligroup-${g.clientId}`,
        label: `入金確認：${g.clientName}`,
        done: g.items.every((cr) => !!cr.payment_confirmed_at),
      })
    }
  }
  for (const p of localPayrollRecords) {
    monthChecks.push({
      key: `payroll-${p.id}`,
      target: `payroll-${p.id}`,
      label: `${PAYROLL_KIND_LABEL[p.payroll_recipients?.kind ?? 'employee']}振込：${p.payroll_recipients?.name ?? '?'}`,
      done: !!p.paid_at,
    })
  }
  if (localGlobal) {
    for (const t of globalTaskDefs) {
      monthChecks.push({ key: `global-${t.field}`, target: 'global-tasks', label: t.label, done: !!localGlobal[t.field] })
    }
  }
  for (const t of customTasks) {
    // 作成前の月まで遡って未完了扱いにしない（months による絞り込みは props 側で済んでいる）。
    const createdDate = new Date(t.created_at)
    const createdYearMonth = createdDate.getFullYear() * 100 + (createdDate.getMonth() + 1)
    if (createdYearMonth > yearMonth) continue
    monthChecks.push({ key: `custom-${t.id}`, target: 'global-tasks', label: t.title, done: t.completed_months.includes(yearMonth) })
  }

  // 進行度パネル。過去月でも「その月をどこまで消し込めたか」が見えるよう、当月と同じ条件で出す。
  const monthDoneCount = monthChecks.filter((c) => c.done).length
  const monthProgressRate = monthChecks.length > 0 ? Math.round((monthDoneCount / monthChecks.length) * 100) : 0

  // 過去月では「今日やること」が出ないため、未完了の行をここから直接たどれるようにする。
  const monthPending = isPastMonth ? monthChecks.filter((c) => !c.done) : []

  // 表示中の月の未完了は「この月の未完了」パネルが担当するため、繰越バナーからは除く。
  const otherMonthCarryOver = carryOver.filter((g) => !(g.year === year && g.month === month))

  const canAdd = newTitle.trim().length > 0 && (
    monthMode === 'all' ||
    (monthMode === 'specific' && selectedMonths.length > 0) ||
    (monthMode === 'single' && newDueDate.length > 0)
  )

  return (
    <div className="space-y-6">
      {/* エラートースト */}
      {errorMsg && <ErrorToast message={errorMsg} onClose={() => setErrorMsg(null)} />}

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" className="h-11 md:h-7" onClick={() => navigate(-1)}>← 前月</Button>
        <h1 className="text-xl font-bold">{year}年{month}月</h1>
        {/* ジャンプバーが画面外にあるときでも過去月と分かるよう、見出しにも印を出す。 */}
        {isPastMonth && (
          <span className="rounded bg-warning-subtle px-2 py-0.5 text-xs text-warning">過去月</span>
        )}
        <Button variant="outline" size="sm" className="h-11 md:h-7" onClick={() => navigate(1)} disabled={isCurrentMonth} title={isCurrentMonth ? '当月が上限です' : undefined}>
          次月 →
        </Button>
      </div>

      {/* セクションジャンプ（1ヶ月分が縦に長く、下部のタスク欄まで数画面スクロールが必要なため） */}
      {/* 過去月は編集できてしまうため、常に見えているこのバーごと警告色にして当月と取り違えないようにする。 */}
      <nav
        className={`sticky top-12 z-10 -mx-4 px-4 md:top-14 ${
          isPastMonth ? 'border-b border-warning/40 bg-warning-subtle' : 'border-b bg-card'
        }`}
      >
        <div className="flex items-center gap-1">
          {isPastMonth && <span className="shrink-0 text-xs text-warning">過去月</span>}
          <ul className="flex flex-1 items-center gap-1 overflow-x-auto md:gap-2">
            {jumpTargets.map((t) => (
              <li key={t.label}>
                <button
                  type="button"
                  onClick={() => {
                    t.onOpen?.()
                    t.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                  className="flex h-11 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground md:h-8 md:px-3"
                >
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
          {isPastMonth && (
            <button
              type="button"
              onClick={goToCurrentMonth}
              className="flex h-11 shrink-0 items-center whitespace-nowrap px-2 text-sm text-warning underline underline-offset-2 md:h-8"
            >
              当月へ
            </button>
          )}
        </div>
      </nav>

      {/* この月の進行度。件数だけだと「あと何件か」は分かっても「どこまで来たか」が分からないため、
          残り件数ではなく完了／全体の割合をバーで見せる。 */}
      {monthChecks.length > 0 && (
        <section className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-bold text-foreground">
            {month}月の進行度 {monthDoneCount}/{monthChecks.length}
          </h2>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-linear-to-r from-primary to-energy transition-[width] duration-500 motion-reduce:transition-none"
                style={{ width: `${monthProgressRate}%` }}
              />
            </div>
            {monthDoneCount === monthChecks.length && (
              <span className="shrink-0 text-xs font-medium text-energy">今月分クリア！</span>
            )}
          </div>
        </section>
      )}

      {/* 繰越未完了バナー */}
      {otherMonthCarryOver.length > 0 && (
        <div className="space-y-2">
          {otherMonthCarryOver.map((g) => (
            <div
              key={`${g.year}-${g.month}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning-subtle px-4 py-2.5 text-sm text-warning"
            >
              <span>
                ⚠ {g.year}年{g.month}月の未完了: {g.items.map((i) => `${i.label} ${i.count}件`).join('、')}
              </span>
              <Link
                href={`/?year=${g.year}&month=${g.month}`}
                className="shrink-0 font-medium text-warning underline underline-offset-2 hover:text-warning"
              >
                確認する
              </Link>
            </div>
          ))}
        </div>
      )}

      {/* この月の未完了（過去月のみ。当月は「今日やること」が担当する） */}
      {monthPending.length > 0 && (
        <section className="rounded-lg border border-warning/40 bg-warning-subtle p-4">
          <h2 className="mb-2 text-sm font-semibold text-warning">この月の未完了 {monthPending.length}件</h2>
          <ul className="flex flex-wrap gap-2">
            {monthPending.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => focusPendingRow(item.target)}
                  className="flex h-11 items-center rounded border border-warning/40 bg-card px-3 text-sm text-warning hover:bg-warning-subtle md:h-8"
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 今日やること */}
      {isCurrentMonth && (
        <TodayTasks
          overdueItems={overdueItems}
          inWindowItems={inWindowItems}
          onJump={focusPendingRow}
          action={
            unreceivedContractorCount > 0 ? (
              <Button
                size="sm"
                variant="outline"
                className="h-11 md:h-7"
                onClick={() => setReminderOpen(true)}
              >
                未提出リマインド（{unreceivedContractorCount}名）
              </Button>
            ) : null
          }
        />
      )}

      {/* 請求書の未提出リマインド。押したときだけ送る（自動送信・定期送信は行わない）。 */}
      <InvoiceReminderDialog
        open={reminderOpen}
        year={year}
        month={month}
        onClose={() => setReminderOpen(false)}
      />

      {/* 要対応の請求書。受け付けた請求書は月に紐づかないため、表示中の月に関係なく出す。 */}
      {invoiceAlert && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning-subtle px-4 py-2.5 text-sm text-warning">
          <span>
            ⚠ 請求書チェック:{' '}
            {INVOICE_ALERT_KINDS
              .filter((k) => invoiceAlert[k.key] > 0)
              .map((k) => `${k.label} ${invoiceAlert[k.key]}件`)
              .join(' / ')}
          </span>
          <Link
            href="/invoice-check"
            className="flex h-11 shrink-0 items-center font-medium text-warning underline underline-offset-2 md:h-auto"
          >
            確認する
          </Link>
        </div>
      )}

      {/* 委託者 — 請求書受領・支払管理 */}
      <section ref={contractorSectionRef} className="scroll-mt-24 rounded-lg border bg-card">
        <SectionHeader
          title="委託者 — 請求書受領・支払管理"
          open={contractorOpen}
          onToggle={() => setContractorOpen((v) => !v)}
          amountLabel="支払"
          amount={contractorCost}
          pending={contractorSummary.pending}
          overdue={contractorSummary.overdue}
          action={
            localRecords.some((r) => r.assignments?.contractors?.contractor_type === 'video_editor') ? (
              <Button size="sm" variant="outline" className="h-11 md:h-7" onClick={runDeliveryCheck} disabled={deliveryLoading}>
                {deliveryLoading ? '納品チェック中…' : `編集者の納品チェック（${deliveryTarget.month}月分）`}
              </Button>
            ) : null
          }
        />
        {contractorOpen && (
        <>
        {deliveryRows && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-b bg-secondary px-4 py-2 text-xs">
            <span className="text-muted-foreground">{deliveryTarget.year}年{deliveryTarget.month}月分の納品: {deliveryRows.length}件</span>
            <span className="text-success">揃った {deliveryRows.filter((r) => deliveryTone(r) === 'done').length}件</span>
            <span className="text-warning">未達 {deliveryRows.filter((r) => deliveryTone(r) === 'short').length}件</span>
            <span className="text-muted-foreground">対象なし {deliveryRows.filter((r) => deliveryTone(r) === 'none').length}件</span>
            <span className="text-danger">要確認 {deliveryRows.filter((r) => deliveryTone(r) === 'attention').length}件</span>
          </div>
        )}
        {localRecords.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4">
            この月の支払記録はまだありません（毎月1日に自動で作成されます）。委託者やアサインが未登録の場合は{' '}
            <Link href="/master" className="text-info underline">マスタ管理</Link>
            {' '}から登録してください。
          </p>
        ) : (
          <>
            {/* PC・タブレット表示（md以上）: 表形式 */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b bg-secondary">
                  <tr>
                    <th className="text-left py-2 px-4 font-medium text-muted-foreground">委託者 / クライアント</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">報酬</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">受領<br /><span className="text-xs text-muted-foreground font-normal">10日</span></th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">支払い予約<br /><span className="text-xs text-muted-foreground font-normal">15日</span></th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">支払い確認<br /><span className="text-xs text-muted-foreground font-normal">末日</span></th>
                  </tr>
                </thead>
                <tbody>
                  {contractorGroups.flatMap((g) => {
                    const multi = g.items.length > 1
                    // 委託者単位の合計報酬（各アサインの報酬＋立替経費の合算）。
                    const total = g.items.reduce(
                      (sum, r) => sum + (recordPayout(r) ?? 0) + expenseTotalOf(r.assignments?.id),
                      0
                    )
                    // 複数クライアントを担当する委託者は「ヘッダー行（名前＋合計）＋明細行（インデント）」で表示する。
                    // 1クライアントだけの委託者は従来どおり1行にまとめ、冗長な行を増やさない。
                    // 支払い確認はこの委託者の全アサインに一括で付ける（支払いはまとめて行うため）。
                    const paidIds = g.items.map((r) => r.id)
                    const allPaid = g.items.every((r) => !!r.contractor_paid_at)
                    // 相手の行（見出し／1件だけの行）の見た目。期限はその委託者の全アサインぶんをまとめて判定し、
                    // 背景ではなく左端のバーで出す（対応色の面は内訳の行だけに使う）。
                    const groupState = rowDueState(
                      g.items.flatMap((r) => [
                        recordDueState(r, 'invoice_received_at', 10),
                        recordDueState(r, 'payment_reserved_at', 15),
                        recordDueState(r, 'contractor_paid_at', lastDay),
                      ])
                    )
                    const groupCls = isCurrentMonth ? groupRowClass(groupState) : 'bg-secondary hover:bg-secondary'
                    const accentCls = isCurrentMonth ? groupAccentClass(groupState) : 'border-l-4 border-l-transparent'
                    // 受領・支払い予約・支払い確認の3点。複数アサインの委託者は「全アサイン分が済んだか」で灯す
                    // （相手単位で見たときに、1件でも残っていれば未完了として見えるようにするため）。
                    const groupPips = [
                      g.items.every((r) => !!r.invoice_received_at),
                      g.items.every((r) => !!r.payment_reserved_at),
                      g.items.every((r) => !!r.contractor_paid_at),
                    ]
                    const headerRow = multi
                      ? [(
                          <tr
                            key={`chead-${g.contractorId}`}
                            data-pending-row={`cgroup-${g.contractorId}`}
                            className={`border-y-2 border-border ${rowBg(`cgroup-${g.contractorId}`, groupCls)}`}
                          >
                            <td className={`py-2 px-4 ${accentCls}`}>
                              <span className="font-semibold text-foreground">{g.contractorName}</span>
                              <ProgressPips states={groupPips} className="mt-1" />
                            </td>
                            <td className="py-2 px-3 text-right">
                              <span className="text-xs text-muted-foreground mr-1">合計</span>
                              <span className="font-semibold text-foreground">¥{total.toLocaleString()}</span>
                            </td>
                            <td colSpan={2} />
                            <td className="text-center py-2 px-3">
                              <MoneyCheckControl
                                checked={allPaid}
                                pending={pendingGroupUncheck?.kind === 'contractor' && pendingGroupUncheck.ids.join(',') === paidIds.join(',')}
                                label={`${g.contractorName}の支払い確認（まとめて）`}
                                onRequest={() => requestBulkContractorPaid(paidIds, allPaid)}
                                onConfirm={confirmGroupUncheck}
                                onCancel={() => setPendingGroupUncheck(null)}
                                badge={<span className="block text-[10px] text-muted-foreground">まとめて</span>}
                              />
                            </td>
                          </tr>
                        )]
                      : []
                    const itemRows = g.items.map((r) => {
                      const asgn = r.assignments
                      const isVideoEditor = asgn?.contractors?.contractor_type === 'video_editor'
                      const receivedState = recordDueState(r, 'invoice_received_at', 10)
                      const reservedState = recordDueState(r, 'payment_reserved_at', 15)
                      const paidState = recordDueState(r, 'contractor_paid_at', lastDay)
                      // 1アサインだけの委託者は、この行が「相手の行」そのものなので見出しの見た目にする
                      // （内訳の対応色と同じ色にすると、上の委託者の内訳と続いて見えて区切りが読めない）。
                      const rowClass = multi
                        ? (isCurrentMonth ? rowDueClass(rowDueState([receivedState, reservedState, paidState])) : 'hover:bg-accent')
                        : groupCls
                      const payout = recordPayout(r)
                      return (
                        <tr
                          key={r.id}
                          data-pending-row={`rec-${r.id}`}
                          className={`${multi ? 'border-b last:border-0' : 'border-y-2 border-border'} ${rowBg(`rec-${r.id}`, rowClass)}`}
                        >
                          <td className={multi ? 'py-3 pl-10 pr-4' : `py-3 px-4 ${accentCls}`}>
                            {multi ? (
                              <div className="text-foreground">{asgn?.clients?.name ?? '?'} · {asgn?.role_name}</div>
                            ) : (
                              <>
                                <div className="font-semibold text-foreground">{g.contractorName}</div>
                                <div className="text-xs text-muted-foreground">{asgn?.clients?.name ?? '?'} · {asgn?.role_name}</div>
                                <ProgressPips states={groupPips} className="mt-1" />
                              </>
                            )}
                            {asgn && (
                              <PaymentCountBadge
                                paymentCount={asgn.payment_count}
                                paid={assignmentPaymentCounts[asgn.id]?.paid ?? 0}
                              />
                            )}
                            {isVideoEditor && (() => {
                              const result = deliveryResult(asgn?.id)
                              if (!result) return null
                              return (
                                <DeliveryCheckNote
                                  row={result}
                                  unitPrice={asgn?.contractors?.unit_price ?? 0}
                                  currentAmount={r.actual_payout_amount}
                                  onApply={(amount, videoCount) => applyDeliveryPayout(r.id, amount, videoCount)}
                                />
                              )
                            })()}
                            {asgn && canAddExpense(r) && (
                              <ExpenseBlock
                                items={expensesByAssignment.get(asgn.id) ?? []}
                                formOpen={expenseFormFor === asgn.id}
                                onOpenForm={() => setExpenseFormFor(asgn.id)}
                                onCloseForm={() => setExpenseFormFor(null)}
                                onAdd={(input) => addExpense(asgn.id, input)}
                                onDelete={deleteExpense}
                              />
                            )}
                          </td>
                          <td className="py-3 px-3 text-right">
                            <PayoutAmountCell
                              amount={payout}
                              editable={!isVideoEditor && !!asgn}
                              edited={r.payout_amount_snapshot !== null && r.payout_amount_snapshot !== asgn?.contractor_payout_amount}
                              strong={!multi}
                              onSave={(value) => savePayoutSnapshot(r.id, value)}
                            />
                            {expenseTotalOf(asgn?.id) > 0 && (
                              <div className="text-xs text-muted-foreground">＋経費 ¥{expenseTotalOf(asgn?.id).toLocaleString()}</div>
                            )}
                          </td>
                          <td className="text-center py-3 px-3">
                            <MoneyCheckControl
                              checked={!!r.invoice_received_at}
                              checkedAt={r.invoice_received_at}
                              pending={pendingUncheck?.kind === 'record' && pendingUncheck.id === r.id && pendingUncheck.field === 'invoice_received_at'}
                              label={`${asgn?.contractors?.name ?? '?'}の請求書受領`}
                              onRequest={() => requestToggleRecord(r.id, 'invoice_received_at', !!r.invoice_received_at)}
                              onConfirm={confirmUncheck}
                              onCancel={cancelUncheck}
                              badge={isCurrentMonth && !r.invoice_received_at && <DueBadge state={receivedState} />}
                            />
                          </td>
                          <td className="text-center py-3 px-3">
                            <MoneyCheckControl
                              checked={!!r.payment_reserved_at}
                              checkedAt={r.payment_reserved_at}
                              pending={pendingUncheck?.kind === 'record' && pendingUncheck.id === r.id && pendingUncheck.field === 'payment_reserved_at'}
                              label={`${asgn?.contractors?.name ?? '?'}の支払い予約`}
                              onRequest={() => requestToggleRecord(r.id, 'payment_reserved_at', !!r.payment_reserved_at)}
                              onConfirm={confirmUncheck}
                              onCancel={cancelUncheck}
                              badge={isCurrentMonth && !r.payment_reserved_at && <DueBadge state={reservedState} />}
                            />
                          </td>
                          {/* 支払い確認は複数アサインの委託者ではヘッダー行に集約する（1操作で全行に付ける）。
                              1アサインだけの委託者は従来どおり行内のチェックで操作する。 */}
                          <td className="text-center py-3 px-3">
                            {!multi && (
                              <MoneyCheckControl
                                checked={!!r.contractor_paid_at}
                                checkedAt={r.contractor_paid_at}
                                pending={pendingUncheck?.kind === 'record' && pendingUncheck.id === r.id && pendingUncheck.field === 'contractor_paid_at'}
                                label={`${asgn?.contractors?.name ?? '?'}の支払い確認`}
                                onRequest={() => requestToggleRecord(r.id, 'contractor_paid_at', !!r.contractor_paid_at)}
                                onConfirm={confirmUncheck}
                                onCancel={cancelUncheck}
                                badge={isCurrentMonth && !r.contractor_paid_at && <DueBadge state={paidState} />}
                              />
                            )}
                          </td>
                        </tr>
                      )
                    })
                    return [...headerRow, ...itemRows]
                  })}
                </tbody>
              </table>
            </div>

            {/* スマホ表示（md未満）: カード形式（1カード=1委託者。複数クライアントを担当していれば内側に並べる） */}
            <div className="divide-y md:hidden">
              {contractorGroups.map((g) => {
                const multi = g.items.length > 1
                const total = g.items.reduce(
                  (sum, r) => sum + (recordPayout(r) ?? 0) + expenseTotalOf(r.assignments?.id),
                  0
                )
                const paidIds = g.items.map((r) => r.id)
                const allPaid = g.items.every((r) => !!r.contractor_paid_at)
                // PC表と同じ考え方で、相手の名前の帯は淡いブルー固定・期限は左端のバーで出す。
                const groupState = rowDueState(
                  g.items.flatMap((r) => [
                    recordDueState(r, 'invoice_received_at', 10),
                    recordDueState(r, 'payment_reserved_at', 15),
                    recordDueState(r, 'contractor_paid_at', lastDay),
                  ])
                )
                const groupCls = isCurrentMonth ? groupRowClass(groupState) : 'bg-secondary'
                const accentCls = isCurrentMonth ? groupAccentClass(groupState) : 'border-l-4 border-l-transparent'
                const groupPips = [
                  g.items.every((r) => !!r.invoice_received_at),
                  g.items.every((r) => !!r.payment_reserved_at),
                  g.items.every((r) => !!r.contractor_paid_at),
                ]
                return (
                  <div
                    key={g.contractorId}
                    data-pending-row={multi ? `cgroup-${g.contractorId}` : undefined}
                    className={`px-4 py-3 ${multi ? rowBg(`cgroup-${g.contractorId}`, '') : ''}`}
                  >
                    <div className={`-mx-4 mb-2 flex items-center justify-between gap-2 px-4 py-2 ${rowBg(`cgroup-${g.contractorId}`, groupCls)} ${accentCls}`}>
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="font-semibold text-foreground">{g.contractorName}</span>
                        <ProgressPips states={groupPips} />
                      </span>
                      {/* 複数クライアントを担当する委託者は、ヘッダーに合計報酬と「支払い確認（まとめて）」を置く */}
                      {multi && (
                        <span className="flex shrink-0 items-center gap-3 text-sm">
                          <span>
                            <span className="text-xs text-muted-foreground mr-1">合計</span>
                            <span className="font-semibold text-foreground">¥{total.toLocaleString()}</span>
                          </span>
                          <span className="flex flex-col items-center gap-0.5">
                            <span className="text-xs text-muted-foreground">支払い確認</span>
                            <MoneyCheckControl
                              checked={allPaid}
                              pending={pendingGroupUncheck?.kind === 'contractor' && pendingGroupUncheck.ids.join(',') === paidIds.join(',')}
                              label={`${g.contractorName}の支払い確認（まとめて）`}
                              onRequest={() => requestBulkContractorPaid(paidIds, allPaid)}
                              onConfirm={confirmGroupUncheck}
                              onCancel={() => setPendingGroupUncheck(null)}
                            />
                          </span>
                        </span>
                      )}
                    </div>
                    <div className="space-y-2">
                      {g.items.map((r) => {
                        const asgn = r.assignments
                        const isVideoEditor = asgn?.contractors?.contractor_type === 'video_editor'
                        const receivedState = recordDueState(r, 'invoice_received_at', 10)
                        const reservedState = recordDueState(r, 'payment_reserved_at', 15)
                        const paidState = recordDueState(r, 'contractor_paid_at', lastDay)
                        // 1アサインだけの委託者は上の名前の帯が期限を示すため、内訳側は塗らない。
                        const cardClass = multi && isCurrentMonth ? rowDueClass(rowDueState([receivedState, reservedState, paidState])) : ''
                        const payout = recordPayout(r)
                        return (
                          <div key={r.id} data-pending-row={`rec-${r.id}`} className={`rounded-lg ${rowBg(`rec-${r.id}`, cardClass)}`}>
                            <div className="mb-1 flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-sm text-muted-foreground">{asgn?.clients?.name ?? '?'} · {asgn?.role_name}</div>
                                {asgn && (
                                  <PaymentCountBadge
                                    paymentCount={asgn.payment_count}
                                    paid={assignmentPaymentCounts[asgn.id]?.paid ?? 0}
                                  />
                                )}
                                {isVideoEditor && (() => {
                                  const result = deliveryResult(asgn?.id)
                                  if (!result) return null
                                  return (
                                    <DeliveryCheckNote
                                      row={result}
                                      unitPrice={asgn?.contractors?.unit_price ?? 0}
                                      currentAmount={r.actual_payout_amount}
                                      onApply={(amount, videoCount) => applyDeliveryPayout(r.id, amount, videoCount)}
                                    />
                                  )
                                })()}
                                {asgn && canAddExpense(r) && (
                                  <ExpenseBlock
                                    items={expensesByAssignment.get(asgn.id) ?? []}
                                    formOpen={expenseFormFor === asgn.id}
                                    onOpenForm={() => setExpenseFormFor(asgn.id)}
                                    onCloseForm={() => setExpenseFormFor(null)}
                                    onAdd={(input) => addExpense(asgn.id, input)}
                                    onDelete={deleteExpense}
                                  />
                                )}
                              </div>
                              <span className="shrink-0 text-right text-sm text-muted-foreground">
                                <PayoutAmountCell
                                  amount={payout}
                                  editable={!isVideoEditor && !!asgn}
                                  edited={r.payout_amount_snapshot !== null && r.payout_amount_snapshot !== asgn?.contractor_payout_amount}
                                  strong={!multi}
                                  onSave={(value) => savePayoutSnapshot(r.id, value)}
                                />
                                {expenseTotalOf(asgn?.id) > 0 && (
                                  <span className="block text-xs text-muted-foreground">＋経費 ¥{expenseTotalOf(asgn?.id).toLocaleString()}</span>
                                )}
                              </span>
                            </div>
                            <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary py-2">
                              <div className="flex flex-col items-center gap-1">
                                <span className="text-xs text-muted-foreground">受領<span className="ml-1 text-muted-foreground">10日</span></span>
                                <MoneyCheckControl
                                  checked={!!r.invoice_received_at}
                                  checkedAt={r.invoice_received_at}
                                  pending={pendingUncheck?.kind === 'record' && pendingUncheck.id === r.id && pendingUncheck.field === 'invoice_received_at'}
                                  label={`${asgn?.contractors?.name ?? '?'}の請求書受領`}
                                  onRequest={() => requestToggleRecord(r.id, 'invoice_received_at', !!r.invoice_received_at)}
                                  onConfirm={confirmUncheck}
                                  onCancel={cancelUncheck}
                                  badge={isCurrentMonth && !r.invoice_received_at && <DueBadge state={receivedState} />}
                                />
                              </div>
                              <div className="flex flex-col items-center gap-1">
                                <span className="text-xs text-muted-foreground">支払い予約<span className="ml-1 text-muted-foreground">15日</span></span>
                                <MoneyCheckControl
                                  checked={!!r.payment_reserved_at}
                                  checkedAt={r.payment_reserved_at}
                                  pending={pendingUncheck?.kind === 'record' && pendingUncheck.id === r.id && pendingUncheck.field === 'payment_reserved_at'}
                                  label={`${asgn?.contractors?.name ?? '?'}の支払い予約`}
                                  onRequest={() => requestToggleRecord(r.id, 'payment_reserved_at', !!r.payment_reserved_at)}
                                  onConfirm={confirmUncheck}
                                  onCancel={cancelUncheck}
                                  badge={isCurrentMonth && !r.payment_reserved_at && <DueBadge state={reservedState} />}
                                />
                              </div>
                              {/* 複数アサインの委託者はカード上部の「支払い確認（まとめて）」に集約するため行内は出さない。 */}
                              <div className="flex flex-col items-center gap-1">
                                <span className="text-xs text-muted-foreground">支払い確認<span className="ml-1 text-muted-foreground">末日</span></span>
                                {multi ? (
                                  <span className="text-xs text-muted-foreground">上でまとめて</span>
                                ) : (
                                  <MoneyCheckControl
                                    checked={!!r.contractor_paid_at}
                                    checkedAt={r.contractor_paid_at}
                                    pending={pendingUncheck?.kind === 'record' && pendingUncheck.id === r.id && pendingUncheck.field === 'contractor_paid_at'}
                                    label={`${asgn?.contractors?.name ?? '?'}の支払い確認`}
                                    onRequest={() => requestToggleRecord(r.id, 'contractor_paid_at', !!r.contractor_paid_at)}
                                    onConfirm={confirmUncheck}
                                    onCancel={cancelUncheck}
                                    badge={isCurrentMonth && !r.contractor_paid_at && <DueBadge state={paidState} />}
                                  />
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
        </>
        )}
      </section>

      {/* クライアント — 請求・入金管理 */}
      <section ref={clientSectionRef} className="scroll-mt-24 rounded-lg border bg-card">
        <SectionHeader
          title="クライアント — 請求・入金管理"
          open={clientOpen}
          onToggle={() => setClientOpen((v) => !v)}
          amountLabel="請求"
          amount={revenue}
          pending={clientSummary.pending}
          overdue={clientSummary.overdue}
        />
        {clientOpen && (
        <>
        {localClientRecords.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4">
            この月の請求記録はまだありません（毎月1日に自動で作成されます）。クライアントが未登録の場合は{' '}
            <Link href="/master" className="text-info underline">マスタ管理</Link>
            {' '}から登録してください。
          </p>
        ) : (
          <>
            {/* PC・タブレット表示（md以上）: 表形式 */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b bg-secondary">
                  <tr>
                    <th className="text-left py-2 px-4 font-medium text-muted-foreground">クライアント</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">請求額</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">送付<br /><span className="text-xs text-muted-foreground font-normal">15日</span></th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">入金確認<br /><span className="text-xs text-muted-foreground font-normal">25日</span></th>
                  </tr>
                </thead>
                <tbody>
                  {clientGroups.flatMap((g) => {
                    // このクライアントに紐づく立替経費（代行者側で登録された分がここに自動で乗る）。
                    const passThroughExpenses = expensesOfClient(g.clientId)
                    const expenseTotal = passThroughExpenses.reduce((s, e) => s + e.amount, 0)
                    // 自社が直接払った経費。委託者には払わないので立替経費とは別行で見せる。
                    const selfExpenses = clientExpensesOf(g.clientId)
                    const selfExpenseTotal = selfExpenses.reduce((s, e) => s + e.amount, 0)
                    // 内訳が1つでも経費があれば、内訳行と経費行が並ぶためグループ表示にする。
                    const multi = g.items.length > 1 || expenseTotal > 0 || selfExpenseTotal > 0
                    // クライアント単位の合計請求額（その月の内訳スナップショット＋立替経費＋自社経費の合算）
                    const total = g.items.reduce((sum, cr) => sum + (cr.billing_amount_snapshot ?? 0), 0) + expenseTotal + selfExpenseTotal
                    // 入金はクライアントからまとめて行われるため、入金確認は全内訳に一括で付ける。
                    const confirmIds = g.items.map((cr) => cr.id)
                    const allConfirmed = g.items.every((cr) => !!cr.payment_confirmed_at)
                    // 相手の行（見出し／1件だけの行）の見た目。期限はそのクライアントの全内訳ぶんをまとめて判定し、
                    // 背景ではなく左端のバーで出す（対応色の面は内訳の行だけに使う）。
                    const groupState = rowDueState(
                      g.items.flatMap((cr) => [
                        clientDueState(cr, 'invoice_sent_at', 15),
                        clientDueState(cr, 'payment_confirmed_at', 25),
                      ])
                    )
                    const groupCls = isCurrentMonth ? groupRowClass(groupState) : 'bg-secondary hover:bg-secondary'
                    const accentCls = isCurrentMonth ? groupAccentClass(groupState) : 'border-l-4 border-l-transparent'
                    // 請求書送付・入金確認の2点。経費行はチェックの体系が違うため、内訳だけで判定する。
                    const groupPips = [
                      g.items.every((cr) => !!cr.invoice_sent_at),
                      g.items.every((cr) => !!cr.payment_confirmed_at),
                    ]
                    // 複数内訳のクライアントは「ヘッダー行（名前＋合計）＋内訳行（インデント）」でグループ表示する。
                    // 内訳が1つだけのクライアントは従来どおり1行（名前＋金額＋チェック）で表示し、冗長な行を増やさない。
                    const headerRow = multi
                      ? [(
                          <tr
                            key={`header-${g.clientId}`}
                            data-pending-row={`cligroup-${g.clientId}`}
                            className={`border-y-2 border-border ${rowBg(`cligroup-${g.clientId}`, groupCls)}`}
                          >
                            <td className={`py-2 px-4 ${accentCls}`}>
                              <span className="font-semibold text-foreground">{g.clientName}</span>
                              <ProgressPips states={groupPips} className="mt-1" />
                            </td>
                            <td className="py-2 px-3 text-right">
                              <span className="text-xs text-muted-foreground mr-1">合計</span>
                              <span className="font-semibold text-foreground">¥{total.toLocaleString()}</span>
                            </td>
                            <td />
                            <td className="text-center py-2 px-3">
                              <MoneyCheckControl
                                checked={allConfirmed}
                                pending={pendingGroupUncheck?.kind === 'client' && pendingGroupUncheck.ids.join(',') === confirmIds.join(',')}
                                label={`${g.clientName}の入金確認（まとめて）`}
                                onRequest={() => requestBulkClientConfirmed(confirmIds, allConfirmed)}
                                onConfirm={confirmGroupUncheck}
                                onCancel={() => setPendingGroupUncheck(null)}
                                badge={<span className="block text-[10px] text-muted-foreground">まとめて</span>}
                              />
                            </td>
                          </tr>
                        )]
                      : []
                    const itemRows = g.items.map((cr) => {
                      const label = itemLabel(cr)
                      const billedCount = billedCounts[cr.billing_item_id] ?? 0
                      const contractMonths = cr.billing_items?.contract_months
                      const overBilled = contractMonths != null && billedCount >= contractMonths
                      const sentState = clientDueState(cr, 'invoice_sent_at', 15)
                      const confirmedState = clientDueState(cr, 'payment_confirmed_at', 25)
                      // 1内訳だけのクライアントは、この行が「相手の行」そのものなので見出しの見た目にする
                      // （内訳の対応色と同じ色にすると、上のクライアントの内訳と続いて見えて区切りが読めない）。
                      const rowClass = multi
                        ? (isCurrentMonth ? rowDueClass(rowDueState([sentState, confirmedState])) : 'hover:bg-accent')
                        : groupCls
                      const labelPart = label ? `（${label}）` : ''
                      return (
                        <tr
                          key={cr.id}
                          data-pending-row={`cli-${cr.id}`}
                          className={`${multi ? 'border-b last:border-0' : 'border-y-2 border-border'} ${rowBg(`cli-${cr.id}`, rowClass)}`}
                        >
                          <td className={multi ? 'py-3 pl-10 pr-4' : `py-3 px-4 ${accentCls}`}>
                            {multi ? (
                              <span className="text-foreground">{label || '（内訳名なし）'}</span>
                            ) : (
                              <>
                                <div className="font-semibold text-foreground">{g.clientName}</div>
                                {label && <div className="text-xs text-muted-foreground">{label}</div>}
                                <ProgressPips states={groupPips} className="mt-1" />
                              </>
                            )}
                            {overBilled && <Badge variant="destructive" className="ml-2 text-xs">請求回数超過</Badge>}
                          </td>
                          <td className={`py-3 px-3 text-right ${multi ? 'text-muted-foreground' : 'font-semibold text-foreground'}`}>
                            {(() => {
                              const billing = cr.billing_amount_snapshot
                              return billing ? `¥${billing.toLocaleString()}` : '—'
                            })()}
                          </td>
                          <td className="text-center py-3 px-3">
                            <MoneyCheckControl
                              checked={!!cr.invoice_sent_at}
                              checkedAt={cr.invoice_sent_at}
                              pending={pendingUncheck?.kind === 'client' && pendingUncheck.id === cr.id && pendingUncheck.field === 'invoice_sent_at'}
                              label={`${g.clientName}${labelPart}の請求書送付`}
                              onRequest={() => requestToggleClientRecord(cr.id, 'invoice_sent_at', !!cr.invoice_sent_at)}
                              onConfirm={confirmUncheck}
                              onCancel={cancelUncheck}
                              badge={isCurrentMonth && !cr.invoice_sent_at && <DueBadge state={sentState} />}
                            />
                          </td>
                          {/* 入金確認は複数内訳のクライアントではヘッダー行に集約する（1操作で全内訳に付ける）。 */}
                          <td className="text-center py-3 px-3">
                            {!multi && (
                              <MoneyCheckControl
                                checked={!!cr.payment_confirmed_at}
                                checkedAt={cr.payment_confirmed_at}
                                pending={pendingUncheck?.kind === 'client' && pendingUncheck.id === cr.id && pendingUncheck.field === 'payment_confirmed_at'}
                                label={`${g.clientName}${labelPart}の入金確認`}
                                onRequest={() => requestToggleClientRecord(cr.id, 'payment_confirmed_at', !!cr.payment_confirmed_at)}
                                onConfirm={confirmUncheck}
                                onCancel={cancelUncheck}
                                badge={isCurrentMonth && !cr.payment_confirmed_at && <DueBadge state={confirmedState} />}
                              />
                            )}
                          </td>
                        </tr>
                      )
                    })
                    // 立替経費の行。委託者側で登録された経費がそのまま請求に乗ることを見せる
                    // （チェック欄は内訳側にあるため、ここは金額の内訳表示のみ）。
                    const expenseRow = expenseTotal > 0
                      ? [(
                          <tr key={`cexp-${g.clientId}`} className="border-b last:border-0">
                            <td className="py-3 pl-10 pr-4 text-foreground">
                              立替経費
                              <span className="ml-1 text-xs text-muted-foreground">
                                （{passThroughExpenses.map((e) => e.note?.trim() || '内容なし').join('、')}）
                              </span>
                            </td>
                            <td className="py-3 px-3 text-right text-muted-foreground">¥{expenseTotal.toLocaleString()}</td>
                            <td className="text-center py-3 px-3">
                              {renderExpenseSentCheck('expense', g.clientId, g.clientName, passThroughExpenses)}
                            </td>
                            <td />
                          </tr>
                        )]
                      : []
                    // 自社経費の行。立替経費と名前を分けているのは、委託者に払う分と払わない分を
                    // 取り違えると委託者への支払額を誤るため。登録もこの行から行う（常時表示）。
                    const selfExpenseRow = [(
                      <tr key={`cself-${g.clientId}`} className="border-b last:border-0">
                        <td className="py-3 pl-10 pr-4 align-top text-foreground">
                          自社経費
                          <ExpenseBlock
                            items={selfExpenses}
                            formOpen={clientExpenseFormFor === g.clientId}
                            onOpenForm={() => setClientExpenseFormFor(g.clientId)}
                            onCloseForm={() => setClientExpenseFormFor(null)}
                            onAdd={(input) => addClientExpense(g.clientId, input)}
                            onDelete={deleteClientExpense}
                            totalLabel="自社経費 計"
                            totalNote="（請求に加算）"
                            addLabel="＋自社経費"
                          />
                        </td>
                        <td className="py-3 px-3 text-right align-top text-muted-foreground">
                          {selfExpenseTotal > 0 ? `¥${selfExpenseTotal.toLocaleString()}` : '—'}
                        </td>
                        <td className="text-center py-3 px-3 align-top">
                          {/* 経費が無い月はチェックする対象が無いため出さない。 */}
                          {selfExpenses.length > 0 && renderExpenseSentCheck('clientExpense', g.clientId, g.clientName, selfExpenses)}
                        </td>
                        <td />
                      </tr>
                    )]
                    return [...headerRow, ...itemRows, ...expenseRow, ...selfExpenseRow]
                  })}
                </tbody>
              </table>
            </div>

            {/* スマホ表示（md未満）: カード形式（1カード=1クライアント。内訳が複数あれば内側に並べる） */}
            <div className="divide-y md:hidden">
              {clientGroups.map((g) => {
                const passThroughExpenses = expensesOfClient(g.clientId)
                const expenseTotal = passThroughExpenses.reduce((s, e) => s + e.amount, 0)
                const selfExpenses = clientExpensesOf(g.clientId)
                const selfExpenseTotal = selfExpenses.reduce((s, e) => s + e.amount, 0)
                const multi = g.items.length > 1 || expenseTotal > 0 || selfExpenseTotal > 0
                const total = g.items.reduce((sum, cr) => sum + (cr.billing_amount_snapshot ?? 0), 0) + expenseTotal + selfExpenseTotal
                const confirmIds = g.items.map((cr) => cr.id)
                const allConfirmed = g.items.every((cr) => !!cr.payment_confirmed_at)
                // PC表と同じ考え方で、相手の名前の帯は淡いブルー固定・期限は左端のバーで出す。
                const groupState = rowDueState(
                  g.items.flatMap((cr) => [
                    clientDueState(cr, 'invoice_sent_at', 15),
                    clientDueState(cr, 'payment_confirmed_at', 25),
                  ])
                )
                const groupCls = isCurrentMonth ? groupRowClass(groupState) : 'bg-secondary'
                const accentCls = isCurrentMonth ? groupAccentClass(groupState) : 'border-l-4 border-l-transparent'
                const groupPips = [
                  g.items.every((cr) => !!cr.invoice_sent_at),
                  g.items.every((cr) => !!cr.payment_confirmed_at),
                ]
                return (
                  <div
                    key={g.clientId}
                    data-pending-row={multi ? `cligroup-${g.clientId}` : undefined}
                    className={`px-4 py-3 ${multi ? rowBg(`cligroup-${g.clientId}`, '') : ''}`}
                  >
                    <div className={`-mx-4 mb-2 flex items-center justify-between gap-2 px-4 py-2 ${rowBg(`cligroup-${g.clientId}`, groupCls)} ${accentCls}`}>
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="font-semibold text-foreground">{g.clientName}</span>
                        <ProgressPips states={groupPips} />
                      </span>
                      {/* 複数内訳のクライアントは、ヘッダーに合計請求額と「入金確認（まとめて）」を置く */}
                      {multi && (
                        <span className="flex shrink-0 items-center gap-3 text-sm">
                          <span>
                            <span className="text-xs text-muted-foreground mr-1">合計</span>
                            <span className="font-semibold text-foreground">¥{total.toLocaleString()}</span>
                          </span>
                          <span className="flex flex-col items-center gap-0.5">
                            <span className="text-xs text-muted-foreground">入金確認</span>
                            <MoneyCheckControl
                              checked={allConfirmed}
                              pending={pendingGroupUncheck?.kind === 'client' && pendingGroupUncheck.ids.join(',') === confirmIds.join(',')}
                              label={`${g.clientName}の入金確認（まとめて）`}
                              onRequest={() => requestBulkClientConfirmed(confirmIds, allConfirmed)}
                              onConfirm={confirmGroupUncheck}
                              onCancel={() => setPendingGroupUncheck(null)}
                            />
                          </span>
                        </span>
                      )}
                    </div>
                    <div className="space-y-2">
                      {g.items.map((cr) => {
                        const label = itemLabel(cr)
                        const labelPart = label ? `（${label}）` : ''
                        const billedCount = billedCounts[cr.billing_item_id] ?? 0
                        const contractMonths = cr.billing_items?.contract_months
                        const overBilled = contractMonths != null && billedCount >= contractMonths
                        const sentState = clientDueState(cr, 'invoice_sent_at', 15)
                        const confirmedState = clientDueState(cr, 'payment_confirmed_at', 25)
                        // 1内訳だけのクライアントは上の名前の帯が期限を示すため、内訳側は塗らない。
                        const cardClass = multi && isCurrentMonth ? rowDueClass(rowDueState([sentState, confirmedState])) : ''
                        const billing = cr.billing_amount_snapshot
                        return (
                          <div key={cr.id} data-pending-row={`cli-${cr.id}`} className={`rounded-lg ${rowBg(`cli-${cr.id}`, cardClass)}`}>
                            <div className="mb-1 flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <span className="text-sm text-muted-foreground">{label || '（内訳名なし）'}</span>
                                {overBilled && <Badge variant="destructive" className="ml-1 text-xs">請求回数超過</Badge>}
                              </div>
                              <span className={`shrink-0 text-sm ${multi ? 'text-muted-foreground' : 'font-semibold text-foreground'}`}>
                                {billing ? `¥${billing.toLocaleString()}` : '—'}
                              </span>
                            </div>
                            <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary py-2">
                              <div className="flex flex-col items-center gap-1">
                                <span className="text-xs text-muted-foreground">送付<span className="ml-1 text-muted-foreground">15日</span></span>
                                <MoneyCheckControl
                                  checked={!!cr.invoice_sent_at}
                                  checkedAt={cr.invoice_sent_at}
                                  pending={pendingUncheck?.kind === 'client' && pendingUncheck.id === cr.id && pendingUncheck.field === 'invoice_sent_at'}
                                  label={`${g.clientName}${labelPart}の請求書送付`}
                                  onRequest={() => requestToggleClientRecord(cr.id, 'invoice_sent_at', !!cr.invoice_sent_at)}
                                  onConfirm={confirmUncheck}
                                  onCancel={cancelUncheck}
                                  badge={isCurrentMonth && !cr.invoice_sent_at && <DueBadge state={sentState} />}
                                />
                              </div>
                              {/* 複数内訳のクライアントはカード上部の「入金確認（まとめて）」に集約するため内訳側は出さない。 */}
                              <div className="flex flex-col items-center gap-1">
                                <span className="text-xs text-muted-foreground">入金確認<span className="ml-1 text-muted-foreground">25日</span></span>
                                {multi ? (
                                  <span className="text-xs text-muted-foreground">上でまとめて</span>
                                ) : (
                                  <MoneyCheckControl
                                    checked={!!cr.payment_confirmed_at}
                                    checkedAt={cr.payment_confirmed_at}
                                    pending={pendingUncheck?.kind === 'client' && pendingUncheck.id === cr.id && pendingUncheck.field === 'payment_confirmed_at'}
                                    label={`${g.clientName}${labelPart}の入金確認`}
                                    onRequest={() => requestToggleClientRecord(cr.id, 'payment_confirmed_at', !!cr.payment_confirmed_at)}
                                    onConfirm={confirmUncheck}
                                    onCancel={cancelUncheck}
                                    badge={isCurrentMonth && !cr.payment_confirmed_at && <DueBadge state={confirmedState} />}
                                  />
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                      {expenseTotal > 0 && (
                        <div className="text-sm">
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0 text-muted-foreground">
                              立替経費
                              <span className="ml-1 text-xs text-muted-foreground">
                                （{passThroughExpenses.map((e) => e.note?.trim() || '内容なし').join('、')}）
                              </span>
                            </span>
                            <span className="shrink-0 text-muted-foreground">¥{expenseTotal.toLocaleString()}</span>
                          </div>
                          <div className="mt-1 flex items-center justify-end gap-2">
                            <span className="text-xs text-muted-foreground">送付</span>
                            {renderExpenseSentCheck('expense', g.clientId, g.clientName, passThroughExpenses)}
                          </div>
                        </div>
                      )}
                      {/* 自社経費。委託者に払う立替経費と取り違えないよう、別の見出しで並べる。 */}
                      <div className="text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <span className="min-w-0 text-muted-foreground">自社経費</span>
                          <span className="shrink-0 text-muted-foreground">
                            {selfExpenseTotal > 0 ? `¥${selfExpenseTotal.toLocaleString()}` : '—'}
                          </span>
                        </div>
                        {selfExpenses.length > 0 && (
                          <div className="mt-1 flex items-center justify-end gap-2">
                            <span className="text-xs text-muted-foreground">送付</span>
                            {renderExpenseSentCheck('clientExpense', g.clientId, g.clientName, selfExpenses)}
                          </div>
                        )}
                        <ExpenseBlock
                          items={selfExpenses}
                          formOpen={clientExpenseFormFor === g.clientId}
                          onOpenForm={() => setClientExpenseFormFor(g.clientId)}
                          onCloseForm={() => setClientExpenseFormFor(null)}
                          onAdd={(input) => addClientExpense(g.clientId, input)}
                          onDelete={deleteClientExpense}
                          totalLabel="自社経費 計"
                          totalNote="（請求に加算）"
                          addLabel="＋自社経費"
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
        </>
        )}
      </section>

      {/* 役員報酬・給与。対象者が未登録の月はカードごと出さない（空の枠を並べても操作が無いため）。 */}
      {localPayrollRecords.length > 0 && (
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">役員報酬・給与</h2>
          <div className="space-y-3">
            {localPayrollRecords.map((p) => {
              const amounts = payrollAmountsOfRecord(p)
              const paid = !!p.paid_at
              const state = payrollDueState(p)
              const name = p.payroll_recipients?.name ?? '?'
              const kindLabel = PAYROLL_KIND_LABEL[p.payroll_recipients?.kind ?? 'employee']
              return (
                <div
                  key={p.id}
                  data-pending-row={`payroll-${p.id}`}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded border-l-4 px-2 py-2 scroll-mt-24 ${
                    state === 'overdue' ? 'border-l-danger' : state === 'inWindow' ? 'border-l-warning' : 'border-l-transparent'
                  } ${rowBg(`payroll-${p.id}`, 'bg-secondary')}`}
                >
                  <div className="min-w-[10rem] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-card px-1.5 py-0.5 text-xs text-muted-foreground">{kindLabel}</span>
                      <span className="text-sm font-medium text-foreground">{name}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      額面 ¥{amounts.gross.toLocaleString()} ・ 控除 ¥{payrollDeductions(amounts).toLocaleString()}
                      ・ 支払日 {payrollDueDay(p)}日
                    </p>
                    <button
                      type="button"
                      onClick={() => setPayrollEditTarget(p)}
                      className="flex h-11 items-center text-xs text-info hover:underline md:h-5"
                    >
                      この月の金額を修正
                    </button>
                  </div>
                  <span className="shrink-0 text-base font-semibold text-foreground">
                    ¥{payrollNet(amounts).toLocaleString()}
                  </span>
                  <div className="shrink-0 text-center">
                    <span className="block text-xs text-muted-foreground">振込済み</span>
                    <MoneyCheckControl
                      checked={paid}
                      checkedAt={p.paid_at}
                      pending={pendingPayrollUncheck === p.id}
                      label={`${name}の${kindLabel}の振込`}
                      onRequest={() => requestTogglePayroll(p.id, paid)}
                      onConfirm={() => { setPendingPayrollUncheck(null); togglePayroll(p.id, false) }}
                      onCancel={() => setPendingPayrollUncheck(null)}
                      badge={isCurrentMonth && !paid && <DueBadge state={state} />}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          {/* 源泉所得税は月ごとにまとめて納付するため、控除の合計をカード内に併記する。 */}
          <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
            今月の源泉所得税（給与分）: <span className="font-semibold text-foreground">¥{payrollIncomeTaxTotal.toLocaleString()}</span>
          </p>
        </section>
      )}

      <PayrollAmountsDialog
        record={payrollEditTarget}
        monthLabel={`${year}年${month}月`}
        onClose={() => setPayrollEditTarget(null)}
        onSave={savePayrollAmounts}
      />

      {/* グローバルタスク（常時表示） */}
      <section ref={globalTaskSectionRef} data-pending-row="global-tasks" className={`scroll-mt-24 rounded-lg border p-4 ${rowBg('global-tasks', 'bg-card')}`}>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-foreground">グローバルタスク</h2>
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            aria-label="タスクを追加"
            aria-expanded={showAddForm}
            className={`flex items-center justify-center w-8 h-8 rounded-full bg-primary hover:bg-primary/85 text-primary-foreground ${TAP_ROUND_BUTTON}`}
          >
            <Plus size={14} />
          </button>
        </div>

        {showAddForm && (
          <div className="mb-4 p-3 border rounded-lg bg-secondary space-y-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCustomTask()}
              placeholder="タスク名を入力..."
              className="w-full text-sm border border-border rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring"
              autoFocus
            />
            {/* 日付（任意）: 表示・メモ用。繰り返し（毎月・特定月）のときだけ入力できる。単発は下の期日を使う。 */}
            {monthMode !== 'single' && (
              <div className="flex items-center gap-2 text-sm">
                <label htmlFor="task-day" className="text-muted-foreground">日付（任意）</label>
                <input
                  id="task-day"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="31"
                  value={newDay}
                  onChange={(e) => setNewDay(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addCustomTask()}
                  placeholder="—"
                  className="w-16 text-sm border border-border rounded px-2 py-1.5 text-right focus:outline-none focus:ring-1 focus:ring-ring [appearance:textfield] [-moz-appearance:textfield]"
                />
                <span className="text-muted-foreground">日</span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label htmlFor="mode-all" className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="month-mode" id="mode-all" checked={monthMode === 'all'} onChange={() => setMonthMode('all')} />
                毎月
              </label>
              <label htmlFor="mode-specific" className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="month-mode" id="mode-specific" checked={monthMode === 'specific'} onChange={() => setMonthMode('specific')} />
                特定月のみ
              </label>
              <label htmlFor="mode-single" className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="month-mode" id="mode-single" checked={monthMode === 'single'} onChange={() => setMonthMode('single')} />
                単発
              </label>
            </div>
            {monthMode === 'single' && (
              <div className="flex items-center gap-2 text-sm">
                <label htmlFor="task-due-date" className="text-muted-foreground">期日</label>
                <input
                  id="task-due-date"
                  type="date"
                  value={newDueDate}
                  onChange={(e) => setNewDueDate(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addCustomTask()}
                  className="text-sm border border-border rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            )}
            {monthMode === 'specific' && (
              <div className="space-y-1">
                <div className="flex flex-wrap gap-1">
                  {[1,2,3,4,5,6,7,8,9,10,11,12].map((m) => (
                    <button
                      type="button"
                      key={m}
                      onClick={() => setSelectedMonths((prev) => prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m])}
                      className={`inline-flex min-h-11 items-center justify-center px-3 py-1.5 text-xs rounded-full border md:min-h-0 ${selectedMonths.includes(m) ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground hover:bg-accent'}`}
                    >
                      {m}月
                    </button>
                  ))}
                </div>
                {selectedMonths.length === 0 && (
                  <p className="text-xs text-danger">対象の月を1つ以上選択してください</p>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="h-11 md:h-7" onClick={addCustomTask} disabled={!canAdd || isAdding}>
                {isAdding ? '追加中…' : '追加'}
              </Button>
              <Button size="sm" variant="outline" className="h-11 md:h-7" onClick={resetAddForm}>キャンセル</Button>
            </div>
          </div>
        )}

        {!localGlobal ? (
          <p className="text-sm text-muted-foreground">今月のデータはまだ作成されていません。翌月1日に自動で生成されます。</p>
        ) : (
          <div className="space-y-2">
            {visibleGlobalTasks.map((t) => {
              const done = !!localGlobal[t.field]
              const isPendingUncheck = pendingGlobalUncheck === t.field
              return (
                <div key={t.field} className={`flex min-h-11 items-center gap-3 md:min-h-0 ${done ? 'opacity-50' : ''}`}>
                  <Checkbox checked={done} onCheckedChange={() => requestToggleGlobal(t.field, done)} className={TAP_CHECKBOX} />
                  <span className={`flex-1 text-sm ${done ? 'line-through text-muted-foreground' : ''}`}>{t.label}</span>
                  {isPendingUncheck ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="whitespace-nowrap text-xs text-muted-foreground">外しますか？</span>
                      <button
                        type="button"
                        onClick={() => { setPendingGlobalUncheck(null); toggleGlobal(t.field) }}
                        className="flex h-11 min-w-11 items-center justify-center rounded px-1.5 text-xs font-medium text-danger hover:bg-danger-subtle md:h-auto md:min-w-0 md:py-0.5"
                      >
                        外す
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingGlobalUncheck(null)}
                        className="flex h-11 min-w-11 items-center justify-center rounded px-1.5 text-xs text-muted-foreground hover:bg-accent md:h-auto md:min-w-0 md:py-0.5"
                      >
                        戻る
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="text-xs text-muted-foreground">{t.dueLabel}</span>
                      {t.state === 'overdue' && (
                        <span className="text-xs bg-danger-subtle text-danger px-2 py-0.5 rounded">期限超過</span>
                      )}
                      {t.state === 'upcoming' && (
                        <span className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded">対応期間前</span>
                      )}
                    </>
                  )}
                </div>
              )
            })}
            {customTasks.length > 0 && (
              <>
                <div className="border-t my-2" />
                {customTasks.map((t) => {
                  const done = t.completed_months.includes(yearMonth)
                  const isPendingDelete = pendingDeleteId === t.id
                  const state = customTaskState(t)
                  return (
                    <div key={t.id} className={`flex min-h-11 flex-wrap items-center gap-3 md:min-h-0 ${done ? 'opacity-50' : ''}`}>
                      <Checkbox checked={done} onCheckedChange={() => toggleCustomTask(t.id)} className={TAP_CHECKBOX} />
                      <span className={`flex-1 min-w-0 text-sm ${done ? 'line-through text-muted-foreground' : ''}`}>{renderTaskTitle(t.title)}</span>
                      {t.day != null && (
                        <span className="shrink-0 text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">{t.day}日</span>
                      )}
                      {t.months.length > 0 && (
                        <div className="flex flex-wrap gap-1 shrink-0">
                          {t.months.length <= 4
                            ? t.months.map((m) => (
                                <span key={m} className="text-xs bg-secondary text-muted-foreground px-1.5 py-0.5 rounded">{m}月</span>
                              ))
                            : <span className="text-xs bg-secondary text-muted-foreground px-1.5 py-0.5 rounded">{t.months.length}か月限定</span>
                          }
                        </div>
                      )}
                      {state === 'overdue' && (
                        <span className="shrink-0 text-xs bg-danger-subtle text-danger px-2 py-0.5 rounded">期限超過</span>
                      )}
                      {state === 'inWindow' && (
                        <span className="shrink-0 text-xs bg-warning-subtle text-warning px-2 py-0.5 rounded">対応期間中</span>
                      )}
                      {isPendingDelete ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => deleteCustomTask(t.id)}
                            className="flex h-11 min-w-11 items-center justify-center rounded px-1.5 text-xs font-medium text-danger hover:bg-danger-subtle hover:text-danger md:h-auto md:min-w-0 md:py-0.5"
                          >
                            削除
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDeleteId(null)}
                            className="flex h-11 min-w-11 items-center justify-center rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground md:h-auto md:min-w-0 md:py-0.5"
                          >
                            戻る
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPendingDeleteId(t.id)}
                          aria-label={`${t.title}を削除`}
                          className={`text-muted-foreground/60 hover:text-danger shrink-0 ${TAP_ICON_BUTTON}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  )
                })}
              </>
            )}
            {oneTimeTasks.length > 0 && (
              <>
                <div className="border-t my-2" />
                <p className="text-xs font-medium text-muted-foreground">単発</p>
                {oneTimeTasks.map((t) => {
                  const done = !!t.completed_at
                  const isPendingDelete = pendingDeleteId === t.id
                  const overdue = !done && oneTimeDueState(t.due_date) === 'overdue'
                  return (
                    <div key={t.id} className={`flex min-h-11 flex-wrap items-center gap-3 md:min-h-0 ${done ? 'opacity-50' : ''}`}>
                      <Checkbox checked={done} onCheckedChange={() => toggleOneTimeTask(t.id)} className={TAP_CHECKBOX} />
                      <span className={`flex-1 min-w-0 text-sm ${done ? 'line-through text-muted-foreground' : ''}`}>{renderTaskTitle(t.title)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">{formatDueMd(t.due_date)}</span>
                      {overdue && (
                        <span className="shrink-0 text-xs bg-danger-subtle text-danger px-2 py-0.5 rounded">期限超過</span>
                      )}
                      {isPendingDelete ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => deleteOneTimeTask(t.id)}
                            className="flex h-11 min-w-11 items-center justify-center rounded px-1.5 text-xs font-medium text-danger hover:bg-danger-subtle hover:text-danger md:h-auto md:min-w-0 md:py-0.5"
                          >
                            削除
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDeleteId(null)}
                            className="flex h-11 min-w-11 items-center justify-center rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground md:h-auto md:min-w-0 md:py-0.5"
                          >
                            戻る
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPendingDeleteId(t.id)}
                          aria-label={`${t.title}を削除`}
                          className={`text-muted-foreground/60 hover:text-danger shrink-0 ${TAP_ICON_BUTTON}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  )
                })}
              </>
            )}
          </div>
        )}
      </section>

      {/* 売上・経費・利益サマリー */}
      <section ref={summarySectionRef} className="scroll-mt-24 rounded-lg border bg-card p-4">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="bg-secondary rounded-lg p-3">
            <p className="text-xs text-muted-foreground mb-1">売上</p>
            <p className="text-xl font-medium text-foreground">¥{revenue.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-0.5">クライアント {clientGroups.length}件 / 内訳 {localClientRecords.length}件</p>
          </div>
          <div className="bg-secondary rounded-lg p-3">
            <p className="text-xs text-muted-foreground mb-1">外注費</p>
            <p className="text-xl font-medium text-muted-foreground">¥{contractorCost.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-0.5">委託者 {localRecords.length}件</p>
          </div>
          <div className="bg-secondary rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground">その他経費</p>
              <span className="text-xs bg-info-subtle text-info px-1.5 py-0.5 rounded">MF連携</span>
            </div>
            <p className="text-xl font-medium text-muted-foreground">
              {mfExpense ? `¥${mfExpense.amount.toLocaleString()}` : '—'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {mfExpense
                ? `${new Date(mfExpense.syncedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} 同期済`
                : '未同期'}
            </p>
          </div>
          {/* 利益は「その月の成果」なので、他のタイルより一段目立つヒーロー表示にする。
              ただし赤字の月まで華やかに見せると事の重大さが伝わらないため、
              マイナスのときだけ従来の警告色のタイルに戻す。 */}
          <div className={`rounded-lg p-3 ${profit >= 0 ? 'bg-linear-to-br from-primary to-primary-deep text-primary-foreground' : 'bg-danger-subtle text-danger'}`}>
            <p className={`text-xs mb-1 ${profit >= 0 ? 'text-primary-foreground/80' : 'text-danger'}`}>利益</p>
            <p className="text-xl font-medium">
              ¥{profit.toLocaleString()}
            </p>
            {revenue > 0 && (
              <p className={`text-xs mt-0.5 ${profit >= 0 ? 'text-primary-foreground/80' : 'text-danger'}`}>
                利益率 {Math.round((profit / revenue) * 100)}%
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <div>
            {mfConnected ? (
              <p className="text-xs text-muted-foreground">
                マネーフォワード クラウド会計 連携中
              </p>
            ) : mfExpired ? (
              <p className="text-xs text-danger">
                マネーフォワード連携の有効期限が切れました。再連携してください。
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">マネーフォワード 未連携</p>
            )}
          </div>
          <div className="flex gap-2">
            {!mfConnected && (
              <a
                href="/api/moneyforward/auth"
                className="inline-flex min-h-11 items-center text-xs border border-info-subtle text-info bg-info-subtle hover:bg-info-subtle px-3 py-1.5 rounded md:min-h-0"
              >
                {mfExpired ? 'MF再連携する' : 'MF連携する'}
              </a>
            )}
            {mfConnected && (
              <button
                type="button"
                onClick={syncMFExpenses}
                disabled={isSyncing}
                className="inline-flex min-h-11 items-center text-xs border border-info-subtle text-info bg-info-subtle hover:bg-info-subtle disabled:opacity-50 px-3 py-1.5 rounded md:min-h-0"
              >
                {isSyncing ? '同期中…' : '今すぐ同期'}
              </button>
            )}
          </div>
        </div>

        {/* スナップショット補完（欠損のみ）: 生成漏れ等でnullの金額を現マスタ値で埋める安全操作 */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            金額スナップショットの欠損を、現在のマスタ値で補完します（既存の値は変更しません）。
          </p>
          {snapshotConfirm ? (
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">補完しますか？</span>
              <button
                type="button"
                onClick={backfillSnapshots}
                disabled={snapshotBusy}
                className="inline-flex min-h-11 items-center rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:opacity-50 md:min-h-0"
              >
                {snapshotBusy ? '実行中…' : '実行する'}
              </button>
              <button
                type="button"
                onClick={() => setSnapshotConfirm(false)}
                className="inline-flex min-h-11 items-center rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent md:min-h-0"
              >
                戻る
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSnapshotConfirm(true)}
              className="inline-flex min-h-11 shrink-0 items-center rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent md:min-h-0"
            >
              スナップショット補完
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

