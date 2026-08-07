'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatInTimeZone } from 'date-fns-tz'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { TZ } from '@/lib/dates'
import type { InvoiceCheckRow } from '@/lib/ui-types'

const STATUS_LABEL: Record<InvoiceCheckRow['status'], string> = {
  pending: '未チェック',
  ok: 'OK',
  ng: 'NG',
  hold: '保留',
}

const STATUS_CLASS: Record<InvoiceCheckRow['status'], string> = {
  pending: 'bg-muted text-muted-foreground',
  ok: 'bg-success-subtle text-success',
  ng: 'bg-danger-subtle text-danger',
  hold: 'bg-warning-subtle text-warning',
}

function StatusBadge({ status }: { status: InvoiceCheckRow['status'] }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', STATUS_CLASS[status])}>
      {STATUS_LABEL[status]}
    </span>
  )
}

// 判定理由は改行区切りの1本の文字列。観点ごとに1行なので、改行をそのまま活かして出す。
function CheckNotes({ notes }: { notes: string | null }) {
  if (!notes) return null
  return <p className="text-xs leading-relaxed whitespace-pre-line text-gray-500">{notes}</p>
}

// 受付日時はサーバー保存の UTC 文字列。閲覧端末のタイムゾーンに左右されないよう JST 固定で表示する。
function formatReceivedAt(iso: string): string {
  return formatInTimeZone(iso, TZ, 'M/d HH:mm')
}

function formatAmount(amount: number | null): string {
  return amount === null ? '—' : `¥${amount.toLocaleString()}`
}

// 照合が済んでいれば「システムがどの月として扱ったか」(resolved)を出す。
// 年の記載が無い請求書では読み取り値に年が入らないため、読み取り値のままだと判定の根拠が見えない。
function formatTargetMonth(r: InvoiceCheckRow): string {
  const year = r.resolved_year ?? r.extracted_year
  const month = r.resolved_month ?? r.extracted_month
  if (month === null) return '—'
  return year === null ? `${month}月分` : `${year}年${month}月分`
}

async function readErrorMessage(res: Response, fallback: string) {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return typeof data?.error === 'string' ? data.error : fallback
}

export default function InvoiceCheckClient() {
  const [rows, setRows] = useState<InvoiceCheckRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [extractingId, setExtractingId] = useState<string | null>(null)
  const [recheckingId, setRecheckingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<InvoiceCheckRow | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/invoice-check', { cache: 'no-store' })
      if (!res.ok) throw new Error(await readErrorMessage(res, '一覧の取得に失敗しました。'))
      setRows((await res.json()) as InvoiceCheckRow[])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '通信に失敗しました')
      setRows([])
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function reExtract(id: string) {
    setExtractingId(id)
    setError(null)
    try {
      const res = await fetch(`/api/invoice-check/${id}/extract`, { method: 'POST' })
      if (!res.ok) {
        setError(await readErrorMessage(res, '再読み取りに失敗しました。'))
        return
      }
      // 失敗理由も extract_error として保存済みなので、結果は一覧を取り直して反映する。
      await load()
    } catch {
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    } finally {
      setExtractingId(null)
    }
  }

  async function recheck(id: string) {
    setRecheckingId(id)
    setError(null)
    try {
      const res = await fetch(`/api/invoice-check/${id}/recheck`, { method: 'POST' })
      if (!res.ok) {
        setError(await readErrorMessage(res, '再チェックに失敗しました。'))
        return
      }
      // 照合を行わなかった場合（読み取り失敗行）は一覧に何も出ないため、理由をここで伝える。
      const data = (await res.json().catch(() => null)) as { skipped?: string } | null
      if (typeof data?.skipped === 'string') setError(data.skipped)
      await load()
    } catch {
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    } finally {
      setRecheckingId(null)
    }
  }

  async function confirmDelete() {
    const target = deleteTarget
    setDeleteTarget(null)
    if (!target) return
    setError(null)
    try {
      const res = await fetch(`/api/invoice-check/${target.id}`, { method: 'DELETE' })
      if (!res.ok) {
        setError(await readErrorMessage(res, '削除に失敗しました。'))
        return
      }
      await load()
    } catch {
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  const busy = (id: string) => extractingId === id || recheckingId === id

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-bold">請求書チェック</h1>
        <p className="text-xs leading-relaxed text-gray-500">
          受付URLから届いた請求書PDFと、AIの読み取り・自動照合の結果一覧です。
          読み取りと照合は受付時に自動で行われます。マスタや納品チェックを直したあとは「再チェック」で判定だけやり直せます。
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {!rows && (
        <div className="rounded-lg border bg-white px-4 py-10 text-center text-sm text-gray-500">
          読み込み中…
        </div>
      )}

      {rows && rows.length === 0 && !error && (
        <div className="rounded-lg border border-dashed bg-white px-4 py-10 text-center text-sm text-gray-500">
          受け付けた請求書はまだありません。
        </div>
      )}

      {rows && rows.length > 0 && (
        <>
          {/* 一覧テーブル（PC・タブレット） */}
          <div className="hidden overflow-x-auto rounded-lg border bg-white md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">受付</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600">請求額</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600">支払予定</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">差出人 / 委託者</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">宛名</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">対象月</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">判定</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="text-gray-600">{formatReceivedAt(r.created_at)}</div>
                      <div className="text-xs break-all text-gray-500">{r.file_name}</div>
                      {r.extract_error && <div className="mt-1 text-xs text-danger">{r.extract_error}</div>}
                    </td>
                    <td className="px-3 py-3 text-right font-medium">{formatAmount(r.extracted_amount)}</td>
                    <td className="px-3 py-3 text-right text-gray-600">{formatAmount(r.expected_amount)}</td>
                    <td className="px-3 py-3">
                      <div className="text-gray-600">{r.extracted_issuer ?? '—'}</div>
                      <div className="text-xs text-gray-500">{r.contractor_name ?? '委託者 未特定'}</div>
                    </td>
                    <td className="px-3 py-3 text-gray-600">{r.extracted_addressee ?? '—'}</td>
                    <td className="px-3 py-3 whitespace-nowrap text-gray-600">{formatTargetMonth(r)}</td>
                    <td className="min-w-64 px-3 py-3">
                      <StatusBadge status={r.status} />
                      <div className="mt-1"><CheckNotes notes={r.check_notes} /></div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                        <a
                          href={`/api/invoice-check/${r.id}/pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-info hover:underline"
                        >
                          PDFを開く
                        </a>
                        <button
                          type="button"
                          onClick={() => recheck(r.id)}
                          disabled={busy(r.id)}
                          className="text-info hover:underline disabled:text-gray-400"
                        >
                          {recheckingId === r.id ? 'チェック中…' : '再チェック'}
                        </button>
                        <button
                          type="button"
                          onClick={() => reExtract(r.id)}
                          disabled={busy(r.id)}
                          className="text-info hover:underline disabled:text-gray-400"
                        >
                          {extractingId === r.id ? '読み取り中…' : '再読み取り・再チェック'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(r)}
                          className="text-danger hover:underline"
                        >
                          削除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 一覧カード（スマホ） */}
          <div className="divide-y rounded-lg border bg-white md:hidden">
            {rows.map((r) => (
              <div key={r.id} className="px-4 py-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium break-all">{r.file_name}</div>
                    <div className="text-xs text-gray-500">{formatReceivedAt(r.created_at)} 受付</div>
                  </div>
                  <StatusBadge status={r.status} />
                </div>

                <div className="space-y-1 rounded-lg bg-gray-50 px-3 py-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-500">請求額</span>
                    <span className="font-medium text-gray-900">{formatAmount(r.extracted_amount)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-500">支払予定</span>
                    <span className="text-gray-700">{formatAmount(r.expected_amount)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-gray-500">差出人</span>
                    <span className="text-right text-gray-700">{r.extracted_issuer ?? '—'}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-gray-500">委託者</span>
                    <span className="text-right text-gray-700">{r.contractor_name ?? '未特定'}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-gray-500">宛名</span>
                    <span className="text-right text-gray-700">{r.extracted_addressee ?? '—'}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-500">対象月</span>
                    <span className="text-gray-700">{formatTargetMonth(r)}</span>
                  </div>
                </div>

                {r.check_notes && <div className="mt-2"><CheckNotes notes={r.check_notes} /></div>}
                {r.extract_error && <div className="mt-2 text-xs text-danger">{r.extract_error}</div>}

                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11"
                    nativeButton={false}
                    render={
                      <a href={`/api/invoice-check/${r.id}/pdf`} target="_blank" rel="noopener noreferrer" />
                    }
                  >
                    PDFを開く
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11"
                    onClick={() => recheck(r.id)}
                    disabled={busy(r.id)}
                  >
                    {recheckingId === r.id ? 'チェック中…' : '再チェック'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11"
                    onClick={() => reExtract(r.id)}
                    disabled={busy(r.id)}
                  >
                    {extractingId === r.id ? '読み取り中…' : '再読み取り・再チェック'}
                  </Button>
                  <Button variant="outline" size="sm" className="h-11 text-danger" onClick={() => setDeleteTarget(r)}>
                    削除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>この請求書を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.file_name}」を削除します。PDFも一緒に消えるため、この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>削除する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
