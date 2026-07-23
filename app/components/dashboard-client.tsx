'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Plus, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { getLastDayOfMonth, getDueState, type DueState } from '@/lib/dates'
import type { CarryOverGroup } from '@/lib/carry-over'
import type { MonthlyGlobalTask, CustomGlobalTask, OneTimeTask } from '@/lib/schema'
import type { RecordWithRelations, ClientRecordWithClient, TaskItem } from '@/lib/ui-types'
import TodayTasks from './today-tasks'
import ErrorToast from './error-toast'

function rowDueState(states: DueState[]): DueState {
  if (states.includes('overdue')) return 'overdue'
  if (states.includes('inWindow')) return 'inWindow'
  return 'done'
}

function rowDueClass(state: DueState): string {
  if (state === 'overdue') return 'bg-danger-subtle/70 hover:bg-danger-subtle/70'
  if (state === 'inWindow') return 'bg-warning-subtle/70 hover:bg-warning-subtle/70'
  return 'hover:bg-gray-50'
}

function DueBadge({ state }: { state: DueState }) {
  if (state === 'overdue') return <span className="block text-[10px] text-danger mt-1">期限超過</span>
  if (state === 'inWindow') return <span className="block text-[10px] text-warning mt-1">今週対応</span>
  return null
}

function formatShortDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
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
        <span className="whitespace-nowrap text-[10px] text-gray-500">外しますか？</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onConfirm}
            className="flex h-11 min-w-11 items-center justify-center rounded px-2 text-xs font-medium text-destructive hover:bg-destructive/10 md:h-6 md:min-w-0"
          >
            外す
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-11 min-w-11 items-center justify-center rounded px-2 text-xs text-gray-400 hover:bg-gray-100 md:h-6 md:min-w-0"
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
      {checked && checkedAt && <span className="text-[10px] text-gray-400">{formatShortDate(checkedAt)}</span>}
      {badge}
    </div>
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
  mfExpense: { amount: number; syncedAt: string } | null
  mfConnected: boolean
  mfExpired: boolean
  mfError: string | null
  mfJustConnected: boolean
  carryOver: CarryOverGroup[]
}

export default function DashboardClient({
  year, month, records, clientRecords, globalTask, customTasks: initialCustomTasks, oneTimeTasks: initialOneTimeTasks, oneTimeWindowDays, today, billedCounts, paidCounts, assignmentPaymentCounts, mfExpense: initialMfExpense, mfConnected, mfExpired, mfError, mfJustConnected, carryOver,
}: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const todayDate = new Date(today)
  const day = todayDate.getDate()
  const lastDay = getLastDayOfMonth(year, month)
  const isCurrentMonth =
    year === todayDate.getFullYear() && month === todayDate.getMonth() + 1

  const [localRecords, setLocalRecords] = useState(records)
  const [localClientRecords, setLocalClientRecords] = useState(clientRecords)
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
  const [pendingGlobalUncheck, setPendingGlobalUncheck] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [mfExpense, setMfExpense] = useState(initialMfExpense)
  const [isSyncing, setIsSyncing] = useState(false)
  const [snapshotConfirm, setSnapshotConfirm] = useState(false)
  const [snapshotBusy, setSnapshotBusy] = useState(false)

  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showError(msg: string) {
    setErrorMsg(msg)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => setErrorMsg(null), 4000)
  }

  useEffect(() => () => { if (errorTimerRef.current) clearTimeout(errorTimerRef.current) }, [])

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
  const revenue = localClientRecords.reduce((sum, cr) => sum + (cr.billing_amount_snapshot ?? 0), 0)
  const contractorCost = localRecords.reduce((sum, r) => {
    const asgn = r.assignments
    if (asgn?.contractors?.contractor_type === 'video_editor') {
      return sum + (r.actual_payout_amount ?? 0)
    }
    return sum + (r.payout_amount_snapshot ?? asgn?.contractor_payout_amount ?? 0)
  }, 0)
  const otherExpenses = mfExpense?.amount ?? 0
  const profit = revenue - contractorCost - otherExpenses

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
  const visibleGlobalTasks = localGlobal
    ? globalTaskDefs.map((t) => ({
        ...t,
        state: getDueState(day, t.dueDay, localGlobal[t.field], t.windowDays),
      }))
    : []

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
      if (t.state === 'overdue') overdueItems.push({ label: `${t.label}` })
      else if (t.state === 'inWindow') inWindowItems.push({ label: `${t.label}` })
    }
    for (const cr of localClientRecords) {
      const baseName = cr.clients?.name ?? '?'
      // 同じクライアントに内訳が複数ある場合は「クライアント / 内訳名」で区別する。
      const isMulti = (clientGroups.find((g) => g.clientId === cr.client_id)?.items.length ?? 0) > 1
      const label = itemLabel(cr)
      const name = isMulti && label ? `${baseName} / ${label}` : baseName
      // クライアント系は件数が多くなるため group を付け、「今日やること」側でグループ折りたたみ表示にする。
      // グループ見出しに作業名（請求書送付/入金確認）が出るので、項目ラベルは名前だけにする。
      const sentState = clientDueState(cr, 'invoice_sent_at', 15)
      if (sentState === 'overdue') overdueItems.push({ label: name, group: 'clientInvoice' })
      else if (sentState === 'inWindow') inWindowItems.push({ label: name, group: 'clientInvoice' })
      const confirmedState = clientDueState(cr, 'payment_confirmed_at', 25)
      if (confirmedState === 'overdue') overdueItems.push({ label: name, group: 'clientPayment' })
      else if (confirmedState === 'inWindow') inWindowItems.push({ label: name, group: 'clientPayment' })
    }
    for (const r of localRecords) {
      const name = r.assignments?.contractors?.name ?? '?'
      const receivedState = recordDueState(r, 'invoice_received_at', 10)
      if (receivedState === 'overdue') overdueItems.push({ label: `${name} — 請求書受領` })
      else if (receivedState === 'inWindow') inWindowItems.push({ label: `${name} — 請求書受領` })
      const reservedState = recordDueState(r, 'payment_reserved_at', 15)
      if (reservedState === 'overdue') overdueItems.push({ label: `${name} — 支払い予約` })
      else if (reservedState === 'inWindow') inWindowItems.push({ label: `${name} — 支払い予約` })
      const paidState = recordDueState(r, 'contractor_paid_at', lastDay)
      if (paidState === 'overdue') overdueItems.push({ label: `${name} — 支払い確認` })
      else if (paidState === 'inWindow') inWindowItems.push({ label: `${name} — 支払い確認` })
    }
    // 単発タスク: 期日超過なら「期限超過」、期日が近い（既定3日以内）なら「対応期間中」に載せる。
    for (const t of oneTimeTasks) {
      if (t.completed_at) continue
      const st = oneTimeDueState(t.due_date)
      const label = `${t.title}（${formatDueMd(t.due_date)}）`
      if (st === 'overdue') overdueItems.push({ label })
      else if (st === 'inWindow') inWindowItems.push({ label })
    }
  }

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
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>← 前月</Button>
        <h1 className="text-xl font-bold">{year}年{month}月</h1>
        <Button variant="outline" size="sm" onClick={() => navigate(1)} disabled={isCurrentMonth} title={isCurrentMonth ? '当月が上限です' : undefined}>
          次月 →
        </Button>
      </div>

      {/* 繰越未完了バナー */}
      {carryOver.length > 0 && (
        <div className="space-y-2">
          {carryOver.map((g) => (
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

      {/* 今日やること */}
      {isCurrentMonth && <TodayTasks overdueItems={overdueItems} inWindowItems={inWindowItems} />}

      {/* 委託者 — 請求書受領・支払管理 */}
      <section className="rounded-lg border bg-white">
        <div className="px-4 pt-4 pb-2 border-b">
          <h2 className="text-sm font-semibold text-gray-700">委託者 — 請求書受領・支払管理</h2>
        </div>
        {localRecords.length === 0 ? (
          <p className="text-sm text-gray-400 p-4">レコード未生成</p>
        ) : (
          <>
            {/* PC・タブレット表示（md以上）: 表形式 */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b bg-gray-50">
                  <tr>
                    <th className="text-left py-2 px-4 font-medium text-gray-600">委託者 / クライアント</th>
                    <th className="text-right py-2 px-3 font-medium text-gray-600">報酬</th>
                    <th className="text-center py-2 px-3 font-medium text-gray-600">受領<br /><span className="text-xs text-gray-400 font-normal">10日</span></th>
                    <th className="text-center py-2 px-3 font-medium text-gray-600">支払予約<br /><span className="text-xs text-gray-400 font-normal">15日</span></th>
                    <th className="text-center py-2 px-3 font-medium text-gray-600">支払確認<br /><span className="text-xs text-gray-400 font-normal">末日</span></th>
                  </tr>
                </thead>
                <tbody>
                  {localRecords.map((r) => {
                    const asgn = r.assignments
                    const isVideoEditor = asgn?.contractors?.contractor_type === 'video_editor'
                    const receivedState = recordDueState(r, 'invoice_received_at', 10)
                    const reservedState = recordDueState(r, 'payment_reserved_at', 15)
                    const paidState = recordDueState(r, 'contractor_paid_at', lastDay)
                    const rowClass = isCurrentMonth ? rowDueClass(rowDueState([receivedState, reservedState, paidState])) : 'hover:bg-gray-50'
                    return (
                      <tr key={r.id} className={`border-b last:border-0 ${rowClass}`}>
                        <td className="py-3 px-4">
                          <div className="font-medium">{asgn?.contractors?.name ?? '?'}</div>
                          <div className="text-xs text-gray-400">{asgn?.clients?.name ?? '?'} · {asgn?.role_name}</div>
                          {asgn && assignmentPaymentCounts[asgn.id] && (
                            <div className="text-xs text-gray-500">累計支払確認: {assignmentPaymentCounts[asgn.id].paid}回 / 予定 {assignmentPaymentCounts[asgn.id].scheduled}回</div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right">
                          {isVideoEditor ? (
                            <PayoutInput
                              recordId={r.id}
                              initialValue={r.actual_payout_amount}
                              onSaved={(val) =>
                                setLocalRecords((prev) =>
                                  prev.map((x) => x.id === r.id ? { ...x, actual_payout_amount: val } : x)
                                )
                              }
                              onError={() => showError('金額の保存に失敗しました。もう一度お試しください。')}
                            />
                          ) : (
                            <span className="text-gray-600">
                              {(() => {
                                const payout = r.payout_amount_snapshot ?? asgn?.contractor_payout_amount
                                return payout ? `¥${payout.toLocaleString()}` : '—'
                              })()}
                            </span>
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
                            label={`${asgn?.contractors?.name ?? '?'}の支払予約`}
                            onRequest={() => requestToggleRecord(r.id, 'payment_reserved_at', !!r.payment_reserved_at)}
                            onConfirm={confirmUncheck}
                            onCancel={cancelUncheck}
                            badge={isCurrentMonth && !r.payment_reserved_at && <DueBadge state={reservedState} />}
                          />
                        </td>
                        <td className="text-center py-3 px-3">
                          <MoneyCheckControl
                            checked={!!r.contractor_paid_at}
                            checkedAt={r.contractor_paid_at}
                            pending={pendingUncheck?.kind === 'record' && pendingUncheck.id === r.id && pendingUncheck.field === 'contractor_paid_at'}
                            label={`${asgn?.contractors?.name ?? '?'}の支払確認`}
                            onRequest={() => requestToggleRecord(r.id, 'contractor_paid_at', !!r.contractor_paid_at)}
                            onConfirm={confirmUncheck}
                            onCancel={cancelUncheck}
                            badge={isCurrentMonth && !r.contractor_paid_at && <DueBadge state={paidState} />}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* スマホ表示（md未満）: カード形式（1カード=1委託者） */}
            <div className="divide-y md:hidden">
              {localRecords.map((r) => {
                const asgn = r.assignments
                const isVideoEditor = asgn?.contractors?.contractor_type === 'video_editor'
                const receivedState = recordDueState(r, 'invoice_received_at', 10)
                const reservedState = recordDueState(r, 'payment_reserved_at', 15)
                const paidState = recordDueState(r, 'contractor_paid_at', lastDay)
                const cardClass = isCurrentMonth ? rowDueClass(rowDueState([receivedState, reservedState, paidState])) : ''
                return (
                  <div key={r.id} className={`px-4 py-3 ${cardClass}`}>
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">{asgn?.contractors?.name ?? '?'}</div>
                        <div className="text-xs text-gray-400">{asgn?.clients?.name ?? '?'} · {asgn?.role_name}</div>
                        {asgn && assignmentPaymentCounts[asgn.id] && (
                          <div className="text-xs text-gray-500">累計支払確認: {assignmentPaymentCounts[asgn.id].paid}回 / 予定 {assignmentPaymentCounts[asgn.id].scheduled}回</div>
                        )}
                      </div>
                      {isVideoEditor ? (
                        <PayoutInput
                          recordId={r.id}
                          initialValue={r.actual_payout_amount}
                          onSaved={(val) =>
                            setLocalRecords((prev) =>
                              prev.map((x) => x.id === r.id ? { ...x, actual_payout_amount: val } : x)
                            )
                          }
                          onError={() => showError('金額の保存に失敗しました。もう一度お試しください。')}
                        />
                      ) : (
                        <span className="shrink-0 text-sm text-gray-600">
                          {(() => {
                            const payout = r.payout_amount_snapshot ?? asgn?.contractor_payout_amount
                            return payout ? `¥${payout.toLocaleString()}` : '—'
                          })()}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-1 rounded-lg bg-gray-50 py-2">
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-xs text-gray-500">受領<span className="ml-1 text-gray-400">10日</span></span>
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
                        <span className="text-xs text-gray-500">支払予約<span className="ml-1 text-gray-400">15日</span></span>
                        <MoneyCheckControl
                          checked={!!r.payment_reserved_at}
                          checkedAt={r.payment_reserved_at}
                          pending={pendingUncheck?.kind === 'record' && pendingUncheck.id === r.id && pendingUncheck.field === 'payment_reserved_at'}
                          label={`${asgn?.contractors?.name ?? '?'}の支払予約`}
                          onRequest={() => requestToggleRecord(r.id, 'payment_reserved_at', !!r.payment_reserved_at)}
                          onConfirm={confirmUncheck}
                          onCancel={cancelUncheck}
                          badge={isCurrentMonth && !r.payment_reserved_at && <DueBadge state={reservedState} />}
                        />
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-xs text-gray-500">支払確認<span className="ml-1 text-gray-400">末日</span></span>
                        <MoneyCheckControl
                          checked={!!r.contractor_paid_at}
                          checkedAt={r.contractor_paid_at}
                          pending={pendingUncheck?.kind === 'record' && pendingUncheck.id === r.id && pendingUncheck.field === 'contractor_paid_at'}
                          label={`${asgn?.contractors?.name ?? '?'}の支払確認`}
                          onRequest={() => requestToggleRecord(r.id, 'contractor_paid_at', !!r.contractor_paid_at)}
                          onConfirm={confirmUncheck}
                          onCancel={cancelUncheck}
                          badge={isCurrentMonth && !r.contractor_paid_at && <DueBadge state={paidState} />}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>

      {/* クライアント — 請求・入金管理 */}
      <section className="rounded-lg border bg-white">
        <div className="px-4 pt-4 pb-2 border-b">
          <h2 className="text-sm font-semibold text-gray-700">クライアント — 請求・入金管理</h2>
        </div>
        {localClientRecords.length === 0 ? (
          <p className="text-sm text-gray-400 p-4">レコード未生成</p>
        ) : (
          <>
            {/* PC・タブレット表示（md以上）: 表形式 */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b bg-gray-50">
                  <tr>
                    <th className="text-left py-2 px-4 font-medium text-gray-600">クライアント</th>
                    <th className="text-right py-2 px-3 font-medium text-gray-600">請求額</th>
                    <th className="text-center py-2 px-3 font-medium text-gray-600">送付<br /><span className="text-xs text-gray-400 font-normal">15日</span></th>
                    <th className="text-center py-2 px-3 font-medium text-gray-600">入金確認<br /><span className="text-xs text-gray-400 font-normal">25日</span></th>
                  </tr>
                </thead>
                <tbody>
                  {clientGroups.flatMap((g) => {
                    const multi = g.items.length > 1
                    // クライアント単位の合計請求額（その月の内訳スナップショットの合算）
                    const total = g.items.reduce((sum, cr) => sum + (cr.billing_amount_snapshot ?? 0), 0)
                    // 複数内訳のクライアントは「ヘッダー行（名前＋合計）＋内訳行（インデント）」でグループ表示する。
                    // 内訳が1つだけのクライアントは従来どおり1行（名前＋金額＋チェック）で表示し、冗長な行を増やさない。
                    const headerRow = multi
                      ? [(
                          <tr key={`header-${g.clientId}`} className="border-b bg-gray-100/80">
                            <td className="py-2 px-4">
                              <span className="font-semibold text-gray-800">{g.clientName}</span>
                            </td>
                            <td className="py-2 px-3 text-right">
                              <span className="text-xs text-gray-500 mr-1">合計</span>
                              <span className="font-semibold text-gray-800">¥{total.toLocaleString()}</span>
                            </td>
                            <td colSpan={2} />
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
                      const rowClass = isCurrentMonth ? rowDueClass(rowDueState([sentState, confirmedState])) : 'hover:bg-gray-50'
                      const labelPart = multi && label ? `（${label}）` : ''
                      return (
                        <tr key={cr.id} className={`border-b last:border-0 ${rowClass}`}>
                          <td className={multi ? 'py-3 pl-10 pr-4' : 'py-3 px-4'}>
                            {multi ? (
                              <span className="text-gray-700">{label || '（内訳名なし）'}</span>
                            ) : (
                              <span className="font-medium">{g.clientName}</span>
                            )}
                            {overBilled && <Badge variant="destructive" className="ml-2 text-xs">請求回数超過</Badge>}
                          </td>
                          <td className="py-3 px-3 text-right text-gray-600">
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
                          <td className="text-center py-3 px-3">
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
                          </td>
                        </tr>
                      )
                    })
                    return [...headerRow, ...itemRows]
                  })}
                </tbody>
              </table>
            </div>

            {/* スマホ表示（md未満）: カード形式（1カード=1クライアント。内訳が複数あれば内側に並べる） */}
            <div className="divide-y md:hidden">
              {clientGroups.map((g) => {
                const multi = g.items.length > 1
                const total = g.items.reduce((sum, cr) => sum + (cr.billing_amount_snapshot ?? 0), 0)
                return (
                  <div key={g.clientId} className="px-4 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="font-medium">{g.clientName}</span>
                      {/* 複数内訳のクライアントは、ヘッダーに合計請求額を表示する */}
                      {multi && (
                        <span className="shrink-0 text-sm">
                          <span className="text-xs text-gray-500 mr-1">合計</span>
                          <span className="font-semibold text-gray-800">¥{total.toLocaleString()}</span>
                        </span>
                      )}
                    </div>
                    <div className="space-y-2">
                      {g.items.map((cr) => {
                        const label = itemLabel(cr)
                        const labelPart = multi && label ? `（${label}）` : ''
                        const billedCount = billedCounts[cr.billing_item_id] ?? 0
                        const contractMonths = cr.billing_items?.contract_months
                        const overBilled = contractMonths != null && billedCount >= contractMonths
                        const sentState = clientDueState(cr, 'invoice_sent_at', 15)
                        const confirmedState = clientDueState(cr, 'payment_confirmed_at', 25)
                        const cardClass = isCurrentMonth ? rowDueClass(rowDueState([sentState, confirmedState])) : ''
                        const billing = cr.billing_amount_snapshot
                        return (
                          <div key={cr.id} className={`rounded-lg ${cardClass}`}>
                            <div className="mb-1 flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                {multi && (
                                  <span className="text-sm text-gray-600">{label || '（内訳名なし）'}</span>
                                )}
                                {overBilled && <Badge variant="destructive" className="ml-1 text-xs">請求回数超過</Badge>}
                              </div>
                              <span className="shrink-0 text-sm text-gray-600">
                                {billing ? `¥${billing.toLocaleString()}` : '—'}
                              </span>
                            </div>
                            <div className="grid grid-cols-2 gap-1 rounded-lg bg-gray-50 py-2">
                              <div className="flex flex-col items-center gap-1">
                                <span className="text-xs text-gray-500">送付<span className="ml-1 text-gray-400">15日</span></span>
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
                              <div className="flex flex-col items-center gap-1">
                                <span className="text-xs text-gray-500">入金確認<span className="ml-1 text-gray-400">25日</span></span>
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
      </section>

      {/* グローバルタスク（常時表示） */}
      <section className="rounded-lg border bg-white p-4">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-gray-700">グローバルタスク</h2>
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            aria-label="タスクを追加"
            aria-expanded={showAddForm}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-700 hover:bg-gray-800 text-white"
          >
            <Plus size={14} />
          </button>
        </div>

        {showAddForm && (
          <div className="mb-4 p-3 border rounded-lg bg-gray-50 space-y-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCustomTask()}
              placeholder="タスク名を入力..."
              className="w-full text-sm border border-gray-200 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-gray-400"
              autoFocus
            />
            {/* 日付（任意）: 表示・メモ用。繰り返し（毎月・特定月）のときだけ入力できる。単発は下の期日を使う。 */}
            {monthMode !== 'single' && (
              <div className="flex items-center gap-2 text-sm">
                <label htmlFor="task-day" className="text-gray-600">日付（任意）</label>
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
                  className="w-16 text-sm border border-gray-200 rounded px-2 py-1.5 text-right focus:outline-none focus:ring-1 focus:ring-gray-400 [appearance:textfield] [-moz-appearance:textfield]"
                />
                <span className="text-gray-500">日</span>
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
                <label htmlFor="task-due-date" className="text-gray-600">期日</label>
                <input
                  id="task-due-date"
                  type="date"
                  value={newDueDate}
                  onChange={(e) => setNewDueDate(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addCustomTask()}
                  className="text-sm border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-gray-400"
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
                      className={`px-3 py-1.5 text-xs rounded border ${selectedMonths.includes(m) ? 'bg-gray-700 text-white border-gray-700' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-100'}`}
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
              <Button size="sm" variant="outline" onClick={addCustomTask} disabled={!canAdd || isAdding}>
                {isAdding ? '追加中…' : '追加'}
              </Button>
              <Button size="sm" variant="outline" onClick={resetAddForm}>キャンセル</Button>
            </div>
          </div>
        )}

        {!localGlobal ? (
          <p className="text-sm text-gray-400">今月のデータはまだ作成されていません。翌月1日に自動で生成されます。</p>
        ) : (
          <div className="space-y-2">
            {visibleGlobalTasks.map((t) => {
              const done = !!localGlobal[t.field]
              const isPendingUncheck = pendingGlobalUncheck === t.field
              return (
                <div key={t.field} className={`flex items-center gap-3 ${done ? 'opacity-50' : ''}`}>
                  <Checkbox checked={done} onCheckedChange={() => requestToggleGlobal(t.field, done)} />
                  <span className={`flex-1 text-sm ${done ? 'line-through text-gray-400' : ''}`}>{t.label}</span>
                  {isPendingUncheck ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="whitespace-nowrap text-xs text-gray-500">外しますか？</span>
                      <button
                        type="button"
                        onClick={() => { setPendingGlobalUncheck(null); toggleGlobal(t.field) }}
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        外す
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingGlobalUncheck(null)}
                        className="rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100"
                      >
                        戻る
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="text-xs text-gray-400">{t.dueLabel}</span>
                      {t.state === 'overdue' && (
                        <span className="text-xs bg-danger-subtle text-danger px-2 py-0.5 rounded">期限超過</span>
                      )}
                      {t.state === 'upcoming' && (
                        <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">対応期間前</span>
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
                  return (
                    <div key={t.id} className={`flex items-center gap-3 ${done ? 'opacity-50' : ''}`}>
                      <Checkbox checked={done} onCheckedChange={() => toggleCustomTask(t.id)} />
                      <span className={`flex-1 min-w-0 text-sm ${done ? 'line-through text-gray-400' : ''}`}>{t.title}</span>
                      {t.day != null && (
                        <span className="shrink-0 text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{t.day}日</span>
                      )}
                      {t.months.length > 0 && (
                        <div className="flex flex-wrap gap-1 shrink-0">
                          {t.months.length <= 4
                            ? t.months.map((m) => (
                                <span key={m} className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{m}月</span>
                              ))
                            : <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{t.months.length}か月限定</span>
                          }
                        </div>
                      )}
                      {isPendingDelete ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => deleteCustomTask(t.id)}
                            className="text-xs text-danger hover:text-danger font-medium px-1.5 py-0.5 rounded hover:bg-danger-subtle"
                          >
                            削除
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDeleteId(null)}
                            className="text-xs text-gray-400 hover:text-gray-600 px-1.5 py-0.5 rounded hover:bg-gray-100"
                          >
                            戻る
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPendingDeleteId(t.id)}
                          aria-label={`${t.title}を削除`}
                          className="text-gray-300 hover:text-danger shrink-0"
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
                <p className="text-xs font-medium text-gray-500">単発</p>
                {oneTimeTasks.map((t) => {
                  const done = !!t.completed_at
                  const isPendingDelete = pendingDeleteId === t.id
                  const overdue = !done && oneTimeDueState(t.due_date) === 'overdue'
                  return (
                    <div key={t.id} className={`flex items-center gap-3 ${done ? 'opacity-50' : ''}`}>
                      <Checkbox checked={done} onCheckedChange={() => toggleOneTimeTask(t.id)} />
                      <span className={`flex-1 min-w-0 text-sm ${done ? 'line-through text-gray-400' : ''}`}>{t.title}</span>
                      <span className="shrink-0 text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{formatDueMd(t.due_date)}</span>
                      {overdue && (
                        <span className="shrink-0 text-xs bg-danger-subtle text-danger px-2 py-0.5 rounded">期限超過</span>
                      )}
                      {isPendingDelete ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => deleteOneTimeTask(t.id)}
                            className="text-xs text-danger hover:text-danger font-medium px-1.5 py-0.5 rounded hover:bg-danger-subtle"
                          >
                            削除
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDeleteId(null)}
                            className="text-xs text-gray-400 hover:text-gray-600 px-1.5 py-0.5 rounded hover:bg-gray-100"
                          >
                            戻る
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPendingDeleteId(t.id)}
                          aria-label={`${t.title}を削除`}
                          className="text-gray-300 hover:text-danger shrink-0"
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
      <section className="rounded-lg border bg-white p-4">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1">売上</p>
            <p className="text-xl font-medium text-gray-900">¥{revenue.toLocaleString()}</p>
            <p className="text-xs text-gray-400 mt-0.5">クライアント {clientGroups.length}件 / 内訳 {localClientRecords.length}件</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1">外注費</p>
            <p className="text-xl font-medium text-gray-600">¥{contractorCost.toLocaleString()}</p>
            <p className="text-xs text-gray-400 mt-0.5">委託者 {localRecords.length}件</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-gray-500">その他経費</p>
              <span className="text-xs bg-info-subtle text-info px-1.5 py-0.5 rounded">MF連携</span>
            </div>
            <p className="text-xl font-medium text-gray-600">
              {mfExpense ? `¥${mfExpense.amount.toLocaleString()}` : '—'}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              {mfExpense
                ? `${new Date(mfExpense.syncedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} 同期済`
                : '未同期'}
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1">利益</p>
            <p className={`text-xl font-medium ${profit >= 0 ? 'text-success' : 'text-danger'}`}>
              ¥{profit.toLocaleString()}
            </p>
            {revenue > 0 && (
              <p className="text-xs text-gray-400 mt-0.5">
                利益率 {Math.round((profit / revenue) * 100)}%
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <div>
            {mfConnected ? (
              <p className="text-xs text-gray-500">
                マネーフォワード クラウド会計 連携中
              </p>
            ) : mfExpired ? (
              <p className="text-xs text-danger">
                マネーフォワード連携の有効期限が切れました。再連携してください。
              </p>
            ) : (
              <p className="text-xs text-gray-500">マネーフォワード 未連携</p>
            )}
          </div>
          <div className="flex gap-2">
            {!mfConnected && (
              <a
                href="/api/moneyforward/auth"
                className="text-xs border border-info-subtle text-info bg-info-subtle hover:bg-info-subtle px-3 py-1.5 rounded"
              >
                {mfExpired ? 'MF再連携する' : 'MF連携する'}
              </a>
            )}
            {mfConnected && (
              <button
                type="button"
                onClick={syncMFExpenses}
                disabled={isSyncing}
                className="text-xs border border-info-subtle text-info bg-info-subtle hover:bg-info-subtle disabled:opacity-50 px-3 py-1.5 rounded"
              >
                {isSyncing ? '同期中…' : '今すぐ同期'}
              </button>
            )}
          </div>
        </div>

        {/* スナップショット補完（欠損のみ）: 生成漏れ等でnullの金額を現マスタ値で埋める安全操作 */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-gray-400">
            金額スナップショットの欠損を、現在のマスタ値で補完します（既存の値は変更しません）。
          </p>
          {snapshotConfirm ? (
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-500">補完しますか？</span>
              <button
                type="button"
                onClick={backfillSnapshots}
                disabled={snapshotBusy}
                className="rounded border border-gray-200 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                {snapshotBusy ? '実行中…' : '実行する'}
              </button>
              <button
                type="button"
                onClick={() => setSnapshotConfirm(false)}
                className="rounded px-2 py-1.5 text-xs text-gray-400 hover:bg-gray-100"
              >
                戻る
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSnapshotConfirm(true)}
              className="shrink-0 rounded border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100"
            >
              スナップショット補完
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

function PayoutInput({ recordId, initialValue, onSaved, onError }: {
  recordId: string
  initialValue: number | null
  onSaved: (val: number | null) => void
  onError: () => void
}) {
  const [value, setValue] = useState(initialValue?.toString() ?? '')
  const [feedback, setFeedback] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function save() {
    setFeedback('saving')
    try {
      const res = await fetch(`/api/checklist/records/${recordId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: 'actual_payout_amount', value }),
      })
      if (!res.ok) throw new Error('save failed')
      const data = await res.json()
      onSaved(data.actual_payout_amount)
      setFeedback('saved')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setFeedback('idle'), 1500)
    } catch {
      setFeedback('idle')
      onError()
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <div className="relative flex items-center">
        <input
          type="number"
          inputMode="numeric"
          value={value}
          placeholder="未入力"
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          className="w-[88px] rounded border border-gray-200 bg-gray-50 px-2 py-1 text-right text-sm [appearance:textfield] [-moz-appearance:textfield] focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <span className="absolute right-1.5 text-gray-400 pointer-events-none text-xs">✏️</span>
      </div>
      {feedback === 'saved' && (
        <span className="text-xs text-success whitespace-nowrap">保存 ✓</span>
      )}
    </div>
  )
}
