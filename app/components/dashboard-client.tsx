'use client'

import { useState, useTransition, useOptimistic, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getLastDayOfMonth } from '@/lib/dates'
import type { MonthlyRecord, MonthlyClientRecord, MonthlyGlobalTask, Assignment, Contractor, Client } from '@/lib/database.types'

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
  today: string
  billedCounts: Record<string, number>
  paidCounts: Record<string, number>
}

export default function DashboardClient({
  year, month, records, clientRecords, globalTask, today, billedCounts, paidCounts,
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
    if (!res.ok) setLocalRecords(records)
    else {
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
    if (!res.ok) setLocalClientRecords(clientRecords)
    else {
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
    if (!res.ok) setLocalGlobal(globalTask)
    else setLocalGlobal(await res.json())
  }

  const globalTaskDefs = [
    { field: 'expense_confirmed_at' as const, label: '社長経費確認', dueLabel: '10日まで', inWindow: day >= 5 && day <= 10 },
    { field: 'payment_report_confirmed_at' as const, label: '支払・報酬 請求書チェック出し', dueLabel: '20日まで', inWindow: day >= 17 && day <= 20 },
    { field: 'withholding_confirmed_at' as const, label: '源泉所得税確認', dueLabel: '月末まで', inWindow: day >= lastDay - 4 && day <= lastDay },
  ]
  const visibleGlobalTasks = localGlobal
    ? globalTaskDefs.filter((t) => !localGlobal[t.field])
    : []

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>← 前月</Button>
        <h1 className="text-xl font-bold">{year}年{month}月</h1>
        <Button variant="outline" size="sm" onClick={() => navigate(1)} disabled={isCurrentMonth} title={isCurrentMonth ? '当月が上限です' : undefined}>
          次月 →
        </Button>
      </div>

      {/* グローバルタスク（常時表示） */}
      <section className="rounded-lg border bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">グローバルタスク</h2>
        {!localGlobal ? (
          <p className="text-sm text-gray-400">レコード未生成（generate-monthly を実行してください）</p>
        ) : visibleGlobalTasks.length === 0 ? (
          <p className="text-sm text-green-600 font-medium">今月のグローバルタスクはすべて完了しました</p>
        ) : (
          <div className="space-y-2">
            {visibleGlobalTasks.map((t) => (
              <div key={t.field} className={`flex items-center gap-3 ${!t.inWindow ? 'opacity-50' : ''}`}>
                <Checkbox checked={!!localGlobal[t.field]} onCheckedChange={() => toggleGlobal(t.field)} />
                <span className="flex-1 text-sm">{t.label}</span>
                <span className="text-xs text-gray-400">{t.dueLabel}</span>
                {!t.inWindow && (
                  <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">対応期間外</span>
                )}
              </div>
            ))}
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

function PayoutInput({ recordId, initialValue, onSaved }: {
  recordId: string
  initialValue: number | null
  onSaved: (val: number | null) => void
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
