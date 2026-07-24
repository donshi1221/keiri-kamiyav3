'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { DeliveryCheckRow } from '@/lib/ui-types'
import { DELIVERY_STATUS_LABEL, deliveryTone, deliveryCacheKey, type DeliveryTone } from '@/lib/delivery-status'

interface Props {
  initialYear: number
  initialMonth: number
}

// 状態バッジ。「揃った / あとN本 / 対象なし / 要確認ラベル」を色で区別する。
function StatusBadge({ row }: { row: DeliveryCheckRow }) {
  const badge = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium'
  const tone = deliveryTone(row)
  if (tone === 'attention') {
    // 到達不能な分岐だが、ラベル取得のため型上も status を絞り込む。
    const label = row.status === 'ok' ? '要確認' : DELIVERY_STATUS_LABEL[row.status]
    return <span className={cn(badge, 'bg-danger-subtle text-danger')}>{label}</span>
  }
  if (tone === 'none') return <span className={cn(badge, 'bg-muted text-muted-foreground')}>対象なし</span>
  if (tone === 'done') return <span className={cn(badge, 'bg-success-subtle text-success')}>✓ 揃った</span>
  return <span className={cn(badge, 'bg-warning-subtle text-warning')}>あと{(row.expected ?? 0) - (row.delivered ?? 0)}本</span>
}

function countTone(rows: DeliveryCheckRow[], tone: DeliveryTone): number {
  return rows.filter((r) => deliveryTone(r) === tone).length
}

export default function DeliveryClient({ initialYear, initialMonth }: Props) {
  const [year, setYear] = useState(initialYear)
  const [month, setMonth] = useState(initialMonth)
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<DeliveryCheckRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 対象月ごとの結果はダッシュボードと共有する。ここでチェックすればダッシュボードでも
  // そのまま金額の反映まで進められるようにするため（画面を往復しても数え直さない）。
  useEffect(() => {
    const cached = sessionStorage.getItem(deliveryCacheKey(year, month))
    setRows(cached ? (JSON.parse(cached) as DeliveryCheckRow[]) : null)
    setError(null)
  }, [year, month])

  function shiftMonth(delta: number) {
    let y = year
    let m = month + delta
    if (m > 12) { m = 1; y++ }
    if (m < 1) { m = 12; y-- }
    setYear(y)
    setMonth(m)
  }

  async function runCheck() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/delivery/check?year=${year}&month=${month}`, { cache: 'no-store' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `集計に失敗しました（HTTP ${res.status}）`)
      }
      const data = (await res.json()) as { rows: DeliveryCheckRow[] }
      setRows(data.rows)
      sessionStorage.setItem(deliveryCacheKey(year, month), JSON.stringify(data.rows))
    } catch (e) {
      setError(e instanceof Error ? e.message : '通信に失敗しました')
      setRows(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー：対象月の選択と実行 */}
      <div className="space-y-3">
        <h1 className="text-xl font-bold">納品チェック</h1>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => shiftMonth(-1)} disabled={loading}>← 前月</Button>
            <span className="min-w-[7rem] text-center font-semibold">{year}年{month}月分</span>
            <Button variant="outline" size="sm" onClick={() => shiftMonth(1)} disabled={loading}>次月 →</Button>
          </div>
          <Button onClick={runCheck} disabled={loading}>
            {loading ? '集計中…' : 'この月をチェック'}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-gray-500">
          各編集者のスプレッドシートの「{month}月」タブを読み、<span className="font-medium">A列（納品〆切）が{month}月</span> かつ{' '}
          <span className="font-medium">D列（納品URL）にURLがある</span> 本数を数えます。
          合否の判断・請求書との照合はご自身で行ってください（このページはデータベースを変更しません）。
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {/* 集計サマリー */}
      {rows && rows.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border bg-white px-4 py-3 text-sm">
          <span className="text-gray-600">対象 <span className="font-semibold text-gray-900">{rows.length}</span> 件</span>
          <span className="text-success">揃った <span className="font-semibold">{countTone(rows, 'done')}</span></span>
          <span className="text-warning">未達 <span className="font-semibold">{countTone(rows, 'short')}</span></span>
          <span className="text-muted-foreground">対象なし <span className="font-semibold">{countTone(rows, 'none')}</span></span>
          <span className="text-danger">要確認 <span className="font-semibold">{countTone(rows, 'attention')}</span></span>
        </div>
      )}

      {/* 未実行 */}
      {!rows && !loading && !error && (
        <div className="rounded-lg border border-dashed bg-white px-4 py-10 text-center text-sm text-gray-500">
          「この月をチェック」を押すと、各編集者のスプレッドシートを読んで納品数を集計します。
        </div>
      )}

      {/* 実行中 */}
      {loading && (
        <div className="rounded-lg border bg-white px-4 py-10 text-center text-sm text-gray-500">
          スプレッドシートを読み込んでいます…
        </div>
      )}

      {/* 結果ゼロ件 */}
      {rows && rows.length === 0 && (
        <div className="rounded-lg border bg-white px-4 py-10 text-center text-sm text-gray-500">
          対象となる動画編集者のアサインがありません。
        </div>
      )}

      {/* 結果テーブル（PC・タブレット） */}
      {rows && rows.length > 0 && (
        <>
          <div className="hidden overflow-x-auto rounded-lg border bg-white md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">編集者 / クライアント</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">タブ</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600">すべき</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600">納品済み</th>
                  <th className="px-3 py-2 text-center font-medium text-gray-600">状態</th>
                  <th className="px-3 py-2 text-center font-medium text-gray-600">シート</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.assignmentId} className="border-b align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.contractorName}</div>
                      <div className="text-xs text-gray-500">{r.clientName} · {r.roleName}</div>
                      {r.message && <div className="mt-1 text-xs text-gray-500">{r.message}</div>}
                    </td>
                    <td className="px-3 py-3 text-gray-600">{r.tabTitle ?? '—'}</td>
                    <td className="px-3 py-3 text-right text-gray-600">{r.expected ?? '—'}</td>
                    <td className="px-3 py-3 text-right font-medium">{r.delivered ?? '—'}</td>
                    <td className="px-3 py-3 text-center"><StatusBadge row={r} /></td>
                    <td className="px-3 py-3 text-center">
                      {r.spreadsheetUrl ? (
                        <a href={r.spreadsheetUrl} target="_blank" rel="noopener noreferrer" className="text-info hover:underline">開く</a>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 結果カード（スマホ） */}
          <div className="divide-y rounded-lg border bg-white md:hidden">
            {rows.map((r) => (
              <div key={r.assignmentId} className="px-4 py-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{r.contractorName}</div>
                    <div className="text-xs text-gray-500">{r.clientName} · {r.roleName}</div>
                  </div>
                  <StatusBadge row={r} />
                </div>
                <div className="flex items-center gap-4 rounded-lg bg-gray-50 px-3 py-2 text-sm">
                  <span className="text-gray-500">すべき <span className="font-medium text-gray-700">{r.expected ?? '—'}</span></span>
                  <span className="text-gray-500">納品済み <span className="font-medium text-gray-700">{r.delivered ?? '—'}</span></span>
                  {r.tabTitle && <span className="ml-auto text-xs text-gray-500">{r.tabTitle}</span>}
                </div>
                {r.message && <div className="mt-1 text-xs text-gray-500">{r.message}</div>}
                {r.spreadsheetUrl && (
                  <a href={r.spreadsheetUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-info hover:underline">
                    スプレッドシートを開く
                  </a>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
