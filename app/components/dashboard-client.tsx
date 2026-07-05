'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Plus, Trash2, X } from 'lucide-react'
import { getLastDayOfMonth } from '@/lib/dates'
import type { MonthlyRecord, MonthlyClientRecord, MonthlyGlobalTask, Assignment, Contractor, Client, CustomGlobalTask } from '@/lib/schema'

type RecordWithRelations = MonthlyRecord & {
  assignments: (Assignment & {
    contractors: (Contractor & { contractor_type: 'daiko' | 'video_editor' }) | null
    clients: Client | null
  }) | null
}

type ClientRecordWithClient = MonthlyClientRecord & {
  clients: (Client & { contract_months: number | null }) | null
}

interface Props {
  year: number
  month: number
  records: RecordWithRelations[]
  clientRecords: ClientRecordWithClient[]
  globalTask: MonthlyGlobalTask | null
  customTasks: CustomGlobalTask[]
  today: string
  billedCounts: Record<string, number>
  paidCounts: Record<string, number>
  mfExpense: { amount: number; syncedAt: string } | null
  mfConnected: boolean
}

export default function DashboardClient({
  year, month, records, clientRecords, globalTask, customTasks: initialCustomTasks, today, billedCounts, paidCounts, mfExpense: initialMfExpense, mfConnected,
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
  const [showAddForm, setShowAddForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [monthMode, setMonthMode] = useState<'all' | 'specific'>('all')
  const [selectedMonths, setSelectedMonths] = useState<number[]>([])
  const [isAdding, setIsAdding] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [mfExpense, setMfExpense] = useState(initialMfExpense)
  const [isSyncing, setIsSyncing] = useState(false)

  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showError(msg: string) {
    setErrorMsg(msg)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => setErrorMsg(null), 4000)
  }

  useEffect(() => () => { if (errorTimerRef.current) clearTimeout(errorTimerRef.current) }, [])

  function navigate(delta: number) {
    if (delta > 0 && isCurrentMonth) return
    let y = year, m = month + delta
    if (m > 12) { m = 1; y++ }
    if (m < 1) { m = 12; y-- }
    startTransition(() => router.push(`/?year=${y}&month=${m}`))
  }

  async function toggleRecord(id: string, field: 'invoice_received_at' | 'contractor_paid_at') {
    setLocalRecords((prev) => prev.map((r) => r.id === id ? { ...r, [field]: r[field] ? null : new Date().toISOString() } : r))
    const res = await fetch(`/api/checklist/records/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field }),
    })
    if (!res.ok) {
      setLocalRecords(records)
      showError('保存に失敗しました。もう一度お試しください。')
    } else {
      const updated = await res.json()
      setLocalRecords((prev) => prev.map((r) => r.id === id ? { ...updated, assignments: r.assignments } : r))
    }
  }

  async function toggleClientRecord(id: string, field: 'invoice_sent_at' | 'payment_confirmed_at') {
    setLocalClientRecords((prev) => prev.map((r) => r.id === id ? { ...r, [field]: r[field] ? null : new Date().toISOString() } : r))
    const res = await fetch(`/api/checklist/client-records/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field }),
    })
    if (!res.ok) {
      setLocalClientRecords(clientRecords)
      showError('保存に失敗しました。もう一度お試しください。')
    } else {
      const updated = await res.json()
      setLocalClientRecords((prev) => prev.map((r) => r.id === id ? { ...updated, clients: r.clients } : r))
    }
  }

  async function toggleGlobal(field: 'expense_confirmed_at' | 'payment_report_confirmed_at' | 'withholding_confirmed_at') {
    if (!localGlobal) return
    setLocalGlobal((prev) => prev ? { ...prev, [field]: prev[field] ? null : new Date().toISOString() } : prev)
    const res = await fetch(`/api/checklist/global/${localGlobal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field }),
    })
    if (!res.ok) {
      setLocalGlobal(globalTask)
      showError('保存に失敗しました。もう一度お試しください。')
    } else {
      setLocalGlobal(await res.json())
    }
  }

  const yearMonth = year * 100 + month

  // 売上・外注費・利益の計算
  const revenue = localClientRecords.reduce((sum, cr) => sum + (cr.clients?.billing_amount ?? 0), 0)
  const contractorCost = localRecords.reduce((sum, r) => {
    const asgn = r.assignments
    if (asgn?.contractors?.contractor_type === 'video_editor') {
      return sum + (r.actual_payout_amount ?? 0)
    }
    return sum + (asgn?.contractor_payout_amount ?? 0)
  }, 0)
  const otherExpenses = mfExpense?.amount ?? 0
  const profit = revenue - contractorCost - otherExpenses

  async function syncMFExpenses() {
    setIsSyncing(true)
    const res = await fetch('/api/moneyforward/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month }),
    })
    setIsSyncing(false)
    if (res.ok) {
      const data = await res.json()
      setMfExpense({ amount: data.amount, syncedAt: new Date().toISOString() })
    } else {
      const data = await res.json()
      if (data.error === 'not_connected') {
        showError('マネーフォワードが未連携です。連携ボタンから認証してください。')
      } else {
        showError('MF経費の同期に失敗しました。もう一度お試しください。')
      }
    }
  }

  async function addCustomTask() {
    if (!newTitle.trim()) return
    if (monthMode === 'specific' && selectedMonths.length === 0) return
    if (isAdding) return
    setIsAdding(true)
    const months = monthMode === 'all' ? [] : selectedMonths
    const res = await fetch('/api/checklist/custom-global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim(), months }),
    })
    setIsAdding(false)
    if (res.ok) {
      const created = await res.json()
      if (monthMode === 'all' || months.includes(month)) {
        setCustomTasks((prev) => [...prev, created])
      }
      setNewTitle('')
      setSelectedMonths([])
      setMonthMode('all')
      setShowAddForm(false)
    } else {
      showError('タスクの追加に失敗しました。もう一度お試しください。')
    }
  }

  async function toggleCustomTask(id: string) {
    setCustomTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, completed_months: t.completed_months.includes(yearMonth) ? t.completed_months.filter((m) => m !== yearMonth) : [...t.completed_months, yearMonth] }
          : t
      )
    )
    const res = await fetch(`/api/checklist/custom-global/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yearMonth }),
    })
    if (!res.ok) {
      setCustomTasks(initialCustomTasks)
      showError('保存に失敗しました。もう一度お試しください。')
    }
  }

  async function deleteCustomTask(id: string) {
    setPendingDeleteId(null)
    setCustomTasks((prev) => prev.filter((t) => t.id !== id))
    const res = await fetch(`/api/checklist/custom-global/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      setCustomTasks(initialCustomTasks)
      showError('削除に失敗しました。もう一度お試しください。')
    }
  }

  const globalTaskDefs = [
    { field: 'expense_confirmed_at' as const, label: '社長経費確認', dueLabel: '10日まで', inWindow: day >= 5 && day <= 10 },
    { field: 'payment_report_confirmed_at' as const, label: '支払・報酬 請求書チェック出し', dueLabel: '20日まで', inWindow: day >= 17 && day <= 20 },
    { field: 'withholding_confirmed_at' as const, label: '源泉所得税確認', dueLabel: '月末まで', inWindow: day >= lastDay - 4 && day <= lastDay },
  ]
  const visibleGlobalTasks = localGlobal ? globalTaskDefs : []

  const canAdd = newTitle.trim().length > 0 && (monthMode === 'all' || selectedMonths.length > 0)

  return (
    <div className="space-y-6">
      {/* エラートースト */}
      {errorMsg && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="shrink-0 text-red-400 hover:text-red-600"
            aria-label="閉じる"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>← 前月</Button>
        <h1 className="text-xl font-bold">{year}年{month}月</h1>
        <Button variant="outline" size="sm" onClick={() => navigate(1)} disabled={isCurrentMonth} title={isCurrentMonth ? '当月が上限です' : undefined}>
          次月 →
        </Button>
      </div>

      {/* 売上・経費・利益サマリー */}
      <section className="rounded-lg border bg-white p-4">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1">売上</p>
            <p className="text-xl font-medium text-gray-900">¥{revenue.toLocaleString()}</p>
            <p className="text-xs text-gray-400 mt-0.5">クライアント {localClientRecords.length}件</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1">外注費</p>
            <p className="text-xl font-medium text-gray-600">¥{contractorCost.toLocaleString()}</p>
            <p className="text-xs text-gray-400 mt-0.5">委託者 {localRecords.length}件</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-gray-500">その他経費</p>
              <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">MF連携</span>
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
            <p className={`text-xl font-medium ${profit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
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
            ) : (
              <p className="text-xs text-gray-500">マネーフォワード 未連携</p>
            )}
          </div>
          <div className="flex gap-2">
            {!mfConnected && (
              <a
                href="/api/moneyforward/auth"
                className="text-xs border border-blue-300 text-blue-600 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded"
              >
                MF連携する
              </a>
            )}
            {mfConnected && (
              <button
                type="button"
                onClick={syncMFExpenses}
                disabled={isSyncing}
                className="text-xs border border-blue-300 text-blue-600 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 px-3 py-1.5 rounded"
              >
                {isSyncing ? '同期中…' : '今すぐ同期'}
              </button>
            )}
          </div>
        </div>
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
            <div className="flex items-center gap-3 text-sm">
              <label htmlFor="mode-all" className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="month-mode" id="mode-all" checked={monthMode === 'all'} onChange={() => setMonthMode('all')} />
                毎月
              </label>
              <label htmlFor="mode-specific" className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="month-mode" id="mode-specific" checked={monthMode === 'specific'} onChange={() => setMonthMode('specific')} />
                特定月のみ
              </label>
            </div>
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
                  <p className="text-xs text-red-500">対象の月を1つ以上選択してください</p>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={addCustomTask} disabled={!canAdd || isAdding}>
                {isAdding ? '追加中…' : '追加'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setShowAddForm(false); setNewTitle(''); setSelectedMonths([]); setMonthMode('all') }}>キャンセル</Button>
            </div>
          </div>
        )}

        {!localGlobal ? (
          <p className="text-sm text-gray-400">今月のデータはまだ作成されていません。翌月1日に自動で生成されます。</p>
        ) : (
          <div className="space-y-2">
            {visibleGlobalTasks.map((t) => {
              const done = !!localGlobal[t.field]
              return (
                <div key={t.field} className={`flex items-center gap-3 ${done ? 'opacity-50' : ''}`}>
                  <Checkbox checked={done} onCheckedChange={() => toggleGlobal(t.field)} />
                  <span className={`flex-1 text-sm ${done ? 'line-through text-gray-400' : ''}`}>{t.label}</span>
                  <span className="text-xs text-gray-400">{t.dueLabel}</span>
                  {!done && !t.inWindow && (
                    <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">対応期間外</span>
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
                            className="text-xs text-red-500 hover:text-red-700 font-medium px-1.5 py-0.5 rounded hover:bg-red-50"
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
                          className="text-gray-300 hover:text-red-400 shrink-0"
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

      {/* クライアント — 請求・入金管理 */}
      <section className="rounded-lg border bg-white">
        <div className="px-4 pt-4 pb-2 border-b">
          <h2 className="text-sm font-semibold text-gray-700">クライアント — 請求・入金管理</h2>
        </div>
        <div className="overflow-x-auto">
          {localClientRecords.length === 0 ? (
            <p className="text-sm text-gray-400 p-4">レコード未生成</p>
          ) : (
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
                {localClientRecords.map((cr) => {
                  const client = cr.clients
                  const clientId = cr.client_id
                  const billedCount = billedCounts[clientId] ?? 0
                  const contractMonths = client?.contract_months
                  const overBilled = contractMonths != null && billedCount >= contractMonths
                  return (
                    <tr key={cr.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="py-3 px-4">
                        <span className="font-medium">{client?.name ?? '?'}</span>
                        {overBilled && <Badge variant="destructive" className="ml-2 text-xs">請求回数超過</Badge>}
                      </td>
                      <td className="py-3 px-3 text-right text-gray-600">
                        {client?.billing_amount ? `¥${client.billing_amount.toLocaleString()}` : '—'}
                      </td>
                      <td className="text-center py-3 px-3">
                        <Checkbox checked={!!cr.invoice_sent_at} onCheckedChange={() => toggleClientRecord(cr.id, 'invoice_sent_at')} />
                      </td>
                      <td className="text-center py-3 px-3">
                        <Checkbox checked={!!cr.payment_confirmed_at} onCheckedChange={() => toggleClientRecord(cr.id, 'payment_confirmed_at')} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* 委託者 — 請求書受領・支払管理 */}
      <section className="rounded-lg border bg-white">
        <div className="px-4 pt-4 pb-2 border-b">
          <h2 className="text-sm font-semibold text-gray-700">委託者 — 請求書受領・支払管理</h2>
        </div>
        <div className="overflow-x-auto">
          {localRecords.length === 0 ? (
            <p className="text-sm text-gray-400 p-4">レコード未生成</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="text-left py-2 px-4 font-medium text-gray-600">委託者 / クライアント</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-600">報酬</th>
                  <th className="text-center py-2 px-3 font-medium text-gray-600">受領<br /><span className="text-xs text-gray-400 font-normal">10日</span></th>
                  <th className="text-center py-2 px-3 font-medium text-gray-600">支払<br /><span className="text-xs text-gray-400 font-normal">末日</span></th>
                </tr>
              </thead>
              <tbody>
                {localRecords.map((r) => {
                  const asgn = r.assignments
                  const isVideoEditor = asgn?.contractors?.contractor_type === 'video_editor'
                  return (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="py-3 px-4">
                        <div className="font-medium">{asgn?.contractors?.name ?? '?'}</div>
                        <div className="text-xs text-gray-400">{asgn?.clients?.name ?? '?'} · {asgn?.role_name}</div>
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
                            {asgn?.contractor_payout_amount ? `¥${asgn.contractor_payout_amount.toLocaleString()}` : '—'}
                          </span>
                        )}
                      </td>
                      <td className="text-center py-3 px-3">
                        <Checkbox checked={!!r.invoice_received_at} onCheckedChange={() => toggleRecord(r.id, 'invoice_received_at')} />
                      </td>
                      <td className="text-center py-3 px-3">
                        <Checkbox checked={!!r.contractor_paid_at} onCheckedChange={() => toggleRecord(r.id, 'contractor_paid_at')} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
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
    const res = await fetch(`/api/checklist/records/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: 'actual_payout_amount', value }),
    })
    if (res.ok) {
      const data = await res.json()
      onSaved(data.actual_payout_amount)
      setFeedback('saved')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setFeedback('idle'), 1500)
    } else {
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
        <span className="text-xs text-green-600 whitespace-nowrap">保存 ✓</span>
      )}
    </div>
  )
}
