'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatInTimeZone } from 'date-fns-tz'
import { ChevronRight } from 'lucide-react'
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
import { FormDialog } from '@/app/components/form-dialog'
import { cn } from '@/lib/utils'
import { TZ } from '@/lib/dates'
import { parseInvoiceNotes } from '@/lib/invoice-notes'
import type { InvoiceCheckRow, InvoiceExtractedPatch, InvoiceNoteLine, InvoiceNoteMark } from '@/lib/ui-types'

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

// NG・保留は人がこれから直すものなので色付きで前に出す。
// 受領・修正は「システムが何をしたか」の記録で、判定の色と混ぜると本当のNGが埋もれるため控えめにする。
// 保存失敗だけは記録でありながら人の対応（再チェック）を待つ状態なので、保留と同じ警告色で前に出す。
const NOTE_CLASS: Record<InvoiceNoteMark, string> = {
  ng: 'rounded bg-danger-subtle px-2 py-1 font-medium text-danger',
  hold: 'rounded bg-warning-subtle px-2 py-1 text-warning',
  saveFailed: 'rounded bg-warning-subtle px-2 py-1 text-warning',
  received: 'text-gray-500',
  fixed: 'text-gray-500',
  saved: 'text-gray-500',
  ok: 'text-gray-500',
}

function NoteLine({ line }: { line: InvoiceNoteLine }) {
  // 印が読めない行は印を付ける前に保存された過去データ。内容が判断できないので中立表示にする。
  return (
    <p className={cn('text-xs leading-relaxed', line.mark ? NOTE_CLASS[line.mark] : 'text-gray-600')}>{line.text}</p>
  )
}

// 判定理由は観点ごとに1行。全行を並べるとOK行がノイズになりNGが埋もれるため、
// 既定ではNG・保留（と受領・修正の記録、印なしの過去データ）だけを出し、OK行は開いたときだけ見せる。
function CheckNotes({ notes }: { notes: string | null }) {
  const [open, setOpen] = useState(false)
  const lines = useMemo(() => parseInvoiceNotes(notes), [notes])
  if (lines.length === 0) return null

  const primary = lines.filter((line) => line.mark !== 'ok')
  const details = lines.filter((line) => line.mark === 'ok')

  return (
    <div className="space-y-1">
      {primary.map((line, i) => (
        <NoteLine key={i} line={line} />
      ))}
      {details.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            // スマホでのタップ領域を44px確保する（PCは従来の行高のまま）。
            className="flex min-h-11 w-full items-center gap-1 text-left text-xs text-info md:min-h-0"
          >
            <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
            <span>{open ? '詳細を閉じる' : `詳細を見る（${details.length}件）`}</span>
          </button>
          {open && (
            <div className="space-y-1 pl-4">
              {details.map((line, i) => (
                <NoteLine key={i} line={line} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
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

// AIの読み取り結果を人が直すフォーム。読み間違いのたびにPDFを投げ直しても同じ結果になりがちなので、
// 値そのものを上書きできる逃げ道を用意する。保存すると続けて自動照合まで走る。
function InvoiceEditDialog({ target, onClose, onSaved, onError }: {
  target: InvoiceCheckRow | null
  onClose: () => void
  onSaved: (skipped: string | null) => void
  onError: (msg: string) => void
}) {
  const [amount, setAmount] = useState('')
  const [issuer, setIssuer] = useState('')
  const [addressee, setAddressee] = useState('')
  const [year, setYear] = useState('')
  const [month, setMonth] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!target) return
    setAmount(target.extracted_amount === null ? '' : String(target.extracted_amount))
    setIssuer(target.extracted_issuer ?? '')
    setAddressee(target.extracted_addressee ?? '')
    // 年は請求書に書かれていないことが多い。照合が補った年（resolved_year）を初期値にすることで、
    // 空欄から入力し直さずに「システムが使った年」をそのまま確定できる。
    setYear(String(target.extracted_year ?? target.resolved_year ?? ''))
    setMonth(String(target.extracted_month ?? target.resolved_month ?? ''))
  }, [target])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!target) return
    setSaving(true)
    // 空欄は 0 ではなく null で送る。「読み取れていない」と「0円と書いてあった」を区別するため。
    const payload: InvoiceExtractedPatch = {
      extracted_amount: amount.trim() === '' ? null : Number(amount),
      extracted_issuer: issuer.trim() === '' ? null : issuer.trim(),
      extracted_addressee: addressee.trim() === '' ? null : addressee.trim(),
      extracted_year: year.trim() === '' ? null : Number(year),
      extracted_month: month.trim() === '' ? null : Number(month),
    }
    try {
      const res = await fetch(`/api/invoice-check/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setSaving(false)
      if (!res.ok) {
        onError(await readErrorMessage(res, '読み取り結果の保存に失敗しました。'))
        return
      }
      // 照合を行わなかった場合は一覧に何も出ないため、理由を呼び出し側へ渡して画面に出す。
      const data = (await res.json().catch(() => null)) as { check?: { skipped?: string } | null } | null
      onSaved(typeof data?.check?.skipped === 'string' ? data.check.skipped : null)
    } catch {
      // 通信断でも fetch は例外になる。setSaving を戻さないと「保存中…」で固着する。
      setSaving(false)
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  return (
    <FormDialog open={!!target} onClose={onClose} title="読み取り結果を修正">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs leading-relaxed text-gray-500">
          「{target?.file_name}」の読み取り結果を直します。保存すると、直した内容で自動照合をやり直します。
          空欄にすると「読み取れていない」状態に戻ります。
        </p>
        <div>
          <label className="text-sm font-medium block mb-1">請求額</label>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm"
            placeholder="未読み取り"
          />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">差出人</label>
          <input
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm"
            placeholder="請求書の発行者名"
          />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">宛名</label>
          <input
            value={addressee}
            onChange={(e) => setAddressee(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm"
            placeholder="請求書の宛名"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium block mb-1">対象年</label>
            <input
              type="number"
              inputMode="numeric"
              min="2000"
              max="2100"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="未読み取り"
            />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">対象月</label>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="12"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="未読み取り"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" className="h-11 md:h-7" type="button" onClick={onClose}>
            キャンセル
          </Button>
          <Button size="sm" className="h-11 md:h-7" type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存して再チェック'}
          </Button>
        </div>
      </form>
    </FormDialog>
  )
}

export default function InvoiceCheckClient() {
  const [rows, setRows] = useState<InvoiceCheckRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [extractingId, setExtractingId] = useState<string | null>(null)
  const [recheckingId, setRecheckingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<InvoiceCheckRow | null>(null)
  const [editTarget, setEditTarget] = useState<InvoiceCheckRow | null>(null)

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

  async function handleEdited(skipped: string | null) {
    setEditTarget(null)
    setError(skipped)
    await load()
  }

  const busy = (id: string) => extractingId === id || recheckingId === id

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-bold">請求書チェック</h1>
        <p className="text-xs leading-relaxed text-gray-500">
          受付URLから届いた請求書PDFと、AIの読み取り・自動照合の結果一覧です。
          読み取りと照合は受付時に自動で行われます。マスタや納品チェックを直したあとは「再チェック」で判定だけやり直せます。
          判定がOKになった請求書は、対象月の「請求書受領」チェックが自動で付き、PDFがGoogleドライブへ保存されます（結果は判定理由に出ます）。
          判定理由はNG・保留の行だけを表示し、一致した項目は「詳細を見る」で開けます。
          AIが読み間違えている場合は「修正」から値を直すと、その内容で照合をやり直します。
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
                        {r.drive_link && (
                          <a
                            href={r.drive_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-info hover:underline"
                          >
                            ドライブで開く
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditTarget(r)}
                          className="text-info hover:underline"
                        >
                          修正
                        </button>
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
                  {r.drive_link && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11"
                      nativeButton={false}
                      render={<a href={r.drive_link} target="_blank" rel="noopener noreferrer" />}
                    >
                      ドライブで開く
                    </Button>
                  )}
                  <Button variant="outline" size="sm" className="h-11" onClick={() => setEditTarget(r)}>
                    修正
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

      <InvoiceEditDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={handleEdited}
        onError={setError}
      />

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
