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
import type {
  InvoiceCheckRow,
  InvoiceDeliverySheetLink,
  InvoiceExtractedPatch,
  InvoiceNoteLine,
  InvoiceNoteMark,
} from '@/lib/ui-types'

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

// クライアント名は一覧の狭い列に何件も並ぶ。法人格はどの社名にも付いていて見分けの役に立たないため、
// 表示だけ落として実名部分に幅を使う（照合には使わない表示専用の処理）。
function shortenClientName(name: string): string {
  return name.replace(/^株式会社/, '').trim() || name
}

// NG（本数ズレ等）の確認先は編集者の納品シート。マスタ→アサインと辿らないと開けなかったため、
// 判定のすぐ下にクライアント別の入口を出す。編集者以外の行では delivery_sheets が空なので何も出ない。
function DeliverySheetLinks({ sheets }: { sheets: InvoiceDeliverySheetLink[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs leading-relaxed text-gray-500">
      <span className="whitespace-nowrap">納品シート</span>
      {/* 区切りとリンクを1つの箱に入れて、折り返しで区切りだけが行末に取り残されるのを防ぐ。 */}
      {sheets.map((sheet, i) => (
        <span key={`${i}-${sheet.url}`} className="inline-flex items-center gap-x-2">
          {i > 0 && <span aria-hidden="true">／</span>}
          <a
            href={sheet.url}
            target="_blank"
            rel="noopener noreferrer"
            title={sheet.clientName}
            // スマホでのタップ領域を44px確保する（PCは従来の行高のまま）。
            className="inline-flex min-h-11 items-center whitespace-nowrap text-info hover:underline md:min-h-0"
          >
            {shortenClientName(sheet.clientName)}
          </a>
        </span>
      ))}
    </div>
  )
}

// ページの説明は毎日読むものではないのに、常時出しておくと一覧の表示領域を圧迫する。
// 常時見せるのは1文に絞り、使い分けの細かい話は開いたときだけ出す。
function UsageNotes() {
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        // スマホでのタップ領域を44px確保する（PCは従来の行高のまま）。
        className="flex min-h-11 items-center gap-1 text-left text-xs text-info md:min-h-0"
      >
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        <span>{open ? '使い方を閉じる' : '使い方を見る'}</span>
      </button>
      {open && (
        <ul className="list-disc space-y-1 pl-8 text-xs leading-relaxed text-gray-500">
          <li>読み取りと照合は受付時に自動で行われます。</li>
          <li>
            編集者の「◯月分」は、その月に納品した分を指します。照合する支払予定額と「請求書受領」チェックは
            翌月の行に付きます（代行者の「◯月分」は従来どおりその月の支払い分です）。
          </li>
          <li>
            マスタや納品チェックを直したあとは「再チェック」で判定だけやり直せます。
            AIの読み取り自体がずれているときは「再読み取り・再チェック」を使います。
          </li>
          <li>AIが読み間違えている場合は「修正」から値を直すと、その内容で照合をやり直します。</li>
          <li>
            請求書にクライアント別の明細があるときは、合計に加えて明細ごとの本数・金額も照合します。
            明細の読み取りがずれている場合は「修正」では直せないため「再読み取り・再チェック」を使います。
          </li>
          <li>
            判定がOKになった請求書は、対象月の「請求書受領」チェックが自動で付き、
            PDFがGoogleドライブへ保存されます（結果は判定理由に出ます）。
          </li>
          <li>判定理由はNG・保留の行だけを表示し、一致した項目は「詳細を見る」で開けます。</li>
        </ul>
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

// 請求額と支払予定額の食い違い。判定そのものはサーバー側が出すが、
// 金額を1セルにまとめると差がぱっと見で分からなくなるため、表示上の強調にだけ使う。
function isAmountMismatch(r: InvoiceCheckRow): boolean {
  return r.extracted_amount !== null && r.expected_amount !== null && r.extracted_amount !== r.expected_amount
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
          受付URLから届いた請求書をAIが読み取り、支払予定額と自動照合します。対応が必要なのは NG・保留 の行だけです。
        </p>
        <UsageNotes />
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
            {/* 列を増やすと日本語が1文字ずつ折り返されて読めなくなるため、関連する値は1セルに縦積みして5列に抑える。
                幅が足りない画面では潰さずに横スクロールさせる（min-w）。 */}
            <table className="w-full min-w-[60rem] text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="w-[13rem] px-4 py-2 text-left font-medium whitespace-nowrap text-gray-600">受付</th>
                  <th className="w-[12rem] px-3 py-2 text-left font-medium whitespace-nowrap text-gray-600">差出人 / 対象月</th>
                  <th className="w-[9rem] px-3 py-2 text-right font-medium whitespace-nowrap text-gray-600">金額</th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-gray-600">判定</th>
                  <th className="w-[11rem] px-3 py-2 text-right font-medium whitespace-nowrap text-gray-600">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="whitespace-nowrap text-gray-600">{formatReceivedAt(r.created_at)}</div>
                      {/* ファイル名は長くて列幅を壊すので1行に省略し、全文は title（マウスを乗せると出る吹き出し）で読めるようにする。 */}
                      <div className="max-w-[11rem] truncate text-xs text-gray-500" title={r.file_name}>
                        {r.file_name}
                      </div>
                      {r.extract_error && <div className="mt-1 text-xs text-danger">{r.extract_error}</div>}
                    </td>
                    <td className="px-3 py-3">
                      {/* 委託者が特定できていれば、以降の作業はマスタ上の名前で行うためそちらを主役にする。 */}
                      <div className="whitespace-nowrap font-medium text-gray-900">
                        {r.contractor_name ?? r.extracted_issuer ?? '—'}
                      </div>
                      {r.contractor_name === null ? (
                        <div className="text-xs whitespace-nowrap text-gray-500">委託者 未特定</div>
                      ) : (
                        r.extracted_issuer !== null && r.extracted_issuer !== r.contractor_name && (
                          <div className="text-xs whitespace-nowrap text-gray-500">差出人 {r.extracted_issuer}</div>
                        )
                      )}
                      <div className="mt-1 text-xs whitespace-nowrap text-gray-500">{formatTargetMonth(r)}</div>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div
                        className={cn(
                          'whitespace-nowrap font-medium',
                          isAmountMismatch(r) ? 'text-danger' : 'text-gray-900'
                        )}
                      >
                        <span className="mr-1 text-xs font-normal text-gray-500">請求</span>
                        {formatAmount(r.extracted_amount)}
                      </div>
                      <div className="whitespace-nowrap text-xs text-gray-500">
                        <span className="mr-1">予定</span>
                        {formatAmount(r.expected_amount)}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge status={r.status} />
                      <div className="mt-1"><CheckNotes notes={r.check_notes} /></div>
                      {r.delivery_sheets.length > 0 && (
                        <div className="mt-1"><DeliverySheetLinks sheets={r.delivery_sheets} /></div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {/* 操作は5つあり横一列だと判定列を圧迫する。折り返して2〜3行に収め、全機能を残す。 */}
                      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs">
                        <a
                          href={`/api/invoice-check/${r.id}/pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="whitespace-nowrap text-info hover:underline"
                        >
                          PDFを開く
                        </a>
                        {r.drive_link && (
                          <a
                            href={r.drive_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="whitespace-nowrap text-info hover:underline"
                          >
                            ドライブで開く
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditTarget(r)}
                          className="whitespace-nowrap text-info hover:underline"
                        >
                          修正
                        </button>
                        <button
                          type="button"
                          onClick={() => recheck(r.id)}
                          disabled={busy(r.id)}
                          className="whitespace-nowrap text-info hover:underline disabled:text-gray-400"
                        >
                          {recheckingId === r.id ? 'チェック中…' : '再チェック'}
                        </button>
                        <button
                          type="button"
                          onClick={() => reExtract(r.id)}
                          disabled={busy(r.id)}
                          className="whitespace-nowrap text-info hover:underline disabled:text-gray-400"
                        >
                          {extractingId === r.id ? '読み取り中…' : '再読み取り・再チェック'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(r)}
                          className="whitespace-nowrap text-danger hover:underline"
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
                {r.delivery_sheets.length > 0 && (
                  <div className="mt-2"><DeliverySheetLinks sheets={r.delivery_sheets} /></div>
                )}

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
