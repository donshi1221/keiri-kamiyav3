'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import type { MonthlyGlobalTask } from '@/lib/schema'
import type { RecordWithRelations, ClientRecordWithClient } from '@/lib/ui-types'

interface Props {
  year: number
  month: number
  records: RecordWithRelations[]
  clientRecords: ClientRecordWithClient[]
  globalTask: MonthlyGlobalTask | null
}

function CheckIcon({ done, label }: { done: boolean; label: string }) {
  if (done) {
    return (
      <span aria-label={`${label}完了（閲覧専用）`} className="text-success text-base leading-none">✓</span>
    )
  }
  return (
    <span aria-label={`${label}未完了（閲覧専用）`} className="text-gray-300 text-base leading-none">○</span>
  )
}

export default function HistoryClient({ year, month, records, clientRecords, globalTask }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  function navigate(delta: number) {
    let y = year, m = month + delta
    if (m > 12) { m = 1; y++ }
    if (m < 1) { m = 12; y-- }
    startTransition(() => router.push(`/history?year=${y}&month=${m}`))
  }

  const globalTaskDefs = [
    { field: 'expense_confirmed_at' as const, label: '社長経費確認', dueLabel: '10日まで' },
    { field: 'payment_report_confirmed_at' as const, label: '支払・報酬 請求書チェック出し', dueLabel: '20日まで' },
    { field: 'withholding_confirmed_at' as const, label: '源泉所得税確認', dueLabel: '月末まで' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>← 前月</Button>
        <h1 className="text-xl font-bold">{year}年{month}月（履歴）</h1>
        <Button variant="outline" size="sm" onClick={() => navigate(1)}>次月 →</Button>
      </div>

      {/* 閲覧専用バナー */}
      <div className="sticky top-12 z-10 bg-warning-subtle border border-warning-subtle text-warning text-sm px-4 py-2 rounded-lg md:top-14">
        過去月（閲覧専用）— この月のデータは変更できません
      </div>

      {/* グローバルタスク */}
      <section className="rounded-lg border bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">グローバルタスク</h2>
        {!globalTask ? (
          <p className="text-sm text-gray-400">レコードなし</p>
        ) : (
          <div className="space-y-2">
            {globalTaskDefs.map((t) => (
              <div key={t.field} className="flex items-center gap-3">
                <CheckIcon done={!!globalTask[t.field]} label={t.label} />
                <span className="flex-1 text-sm">{t.label}</span>
                <span className="text-xs text-gray-400">{t.dueLabel}</span>
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
        {clientRecords.length === 0 ? (
          <p className="text-sm text-gray-400 p-4">レコードなし</p>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b bg-gray-50">
                  <tr>
                    <th className="text-left py-2 px-4 font-medium text-gray-600">クライアント</th>
                    <th className="text-right py-2 px-3 font-medium text-gray-600">請求額</th>
                    <th className="text-center py-2 px-3 font-medium text-gray-600">送付<br /><span className="text-xs font-normal text-gray-400">15日</span></th>
                    <th className="text-center py-2 px-3 font-medium text-gray-600">入金確認<br /><span className="text-xs font-normal text-gray-400">25日</span></th>
                  </tr>
                </thead>
                <tbody>
                  {clientRecords.map((cr) => (
                    <tr key={cr.id} className="border-b last:border-0">
                      <td className="py-3 px-4">
                        <span className="font-medium">{cr.clients?.name ?? '?'}</span>
                        {cr.label_snapshot && (
                          <span className="ml-2 text-xs text-gray-400">{cr.label_snapshot}</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right text-gray-600">
                        {cr.billing_amount_snapshot ? `¥${cr.billing_amount_snapshot.toLocaleString()}` : '—'}
                      </td>
                      <td className="text-center py-3 px-3">
                        <CheckIcon done={!!cr.invoice_sent_at} label="送付" />
                      </td>
                      <td className="text-center py-3 px-3">
                        <CheckIcon done={!!cr.payment_confirmed_at} label="入金確認" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="divide-y md:hidden">
              {clientRecords.map((cr) => {
                const billing = cr.billing_amount_snapshot
                return (
                  <div key={cr.id} className="px-4 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {cr.clients?.name ?? '?'}
                        {cr.label_snapshot && <span className="ml-2 text-xs text-gray-400">{cr.label_snapshot}</span>}
                      </span>
                      <span className="text-sm text-gray-600">{billing ? `¥${billing.toLocaleString()}` : '—'}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1 rounded-lg bg-gray-50 py-2 text-xs text-gray-500">
                      <div className="flex flex-col items-center gap-1">
                        <span>送付<span className="ml-1 text-gray-400">15日</span></span>
                        <CheckIcon done={!!cr.invoice_sent_at} label="送付" />
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <span>入金確認<span className="ml-1 text-gray-400">25日</span></span>
                        <CheckIcon done={!!cr.payment_confirmed_at} label="入金確認" />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>

      {/* 委託者 — 請求書受領・支払管理 */}
      <section className="rounded-lg border bg-white">
        <div className="px-4 pt-4 pb-2 border-b">
          <h2 className="text-sm font-semibold text-gray-700">委託者 — 請求書受領・支払管理</h2>
        </div>
        {records.length === 0 ? (
          <p className="text-sm text-gray-400 p-4">レコードなし</p>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b bg-gray-50">
                  <tr>
                    <th className="text-left py-2 px-4 font-medium text-gray-600">委託者 / クライアント</th>
                    <th className="text-right py-2 px-3 font-medium text-gray-600">報酬</th>
                    <th className="text-center py-2 px-3 font-medium text-gray-600">受領<br /><span className="text-xs font-normal text-gray-400">10日</span></th>
                    <th className="text-center py-2 px-3 font-medium text-gray-600">支払予約<br /><span className="text-xs font-normal text-gray-400">15日</span></th>
                    <th className="text-center py-2 px-3 font-medium text-gray-600">支払確認<br /><span className="text-xs font-normal text-gray-400">末日</span></th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => {
                    const asgn = r.assignments
                    const isVideoEditor = asgn?.contractors?.contractor_type === 'video_editor'
                    const payout = isVideoEditor
                      ? r.actual_payout_amount
                      : (r.payout_amount_snapshot ?? asgn?.contractor_payout_amount)
                    return (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="py-3 px-4">
                          <div className="font-medium">{asgn?.contractors?.name ?? '?'}</div>
                          <div className="text-xs text-gray-400">{asgn?.clients?.name ?? '?'} · {asgn?.role_name}</div>
                        </td>
                        <td className="py-3 px-3 text-right text-gray-600">
                          {payout != null ? `¥${payout.toLocaleString()}` : '—'}
                        </td>
                        <td className="text-center py-3 px-3">
                          <CheckIcon done={!!r.invoice_received_at} label="受領" />
                        </td>
                        <td className="text-center py-3 px-3">
                          <CheckIcon done={!!r.payment_reserved_at} label="支払予約" />
                        </td>
                        <td className="text-center py-3 px-3">
                          <CheckIcon done={!!r.contractor_paid_at} label="支払確認" />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="divide-y md:hidden">
              {records.map((r) => {
                const asgn = r.assignments
                const isVideoEditor = asgn?.contractors?.contractor_type === 'video_editor'
                const payout = isVideoEditor
                  ? r.actual_payout_amount
                  : (r.payout_amount_snapshot ?? asgn?.contractor_payout_amount)
                return (
                  <div key={r.id} className="px-4 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div>
                        <div className="font-medium">{asgn?.contractors?.name ?? '?'}</div>
                        <div className="text-xs text-gray-400">{asgn?.clients?.name ?? '?'} · {asgn?.role_name}</div>
                      </div>
                      <span className="text-sm text-gray-600">{payout != null ? `¥${payout.toLocaleString()}` : '—'}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 rounded-lg bg-gray-50 py-2 text-xs text-gray-500">
                      <div className="flex flex-col items-center gap-1">
                        <span>受領<span className="ml-1 text-gray-400">10日</span></span>
                        <CheckIcon done={!!r.invoice_received_at} label="受領" />
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <span>支払予約<span className="ml-1 text-gray-400">15日</span></span>
                        <CheckIcon done={!!r.payment_reserved_at} label="支払予約" />
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <span>支払確認<span className="ml-1 text-gray-400">末日</span></span>
                        <CheckIcon done={!!r.contractor_paid_at} label="支払確認" />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
