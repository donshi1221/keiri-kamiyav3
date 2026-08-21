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
import type { PaymentRequestRow, PaymentRequestStatus, PaymentExtractOutcome } from '@/lib/ui-types'

// 状態は text 列（enum ではない）なので、未知の値が入っていても画面が壊れないよう
// 対応表に無いときは値そのものを出す作りにする。
const STATUS_LABEL: Record<string, string> = {
  pending: '未対応',
  reserved: '振込予約済み',
  paid: '振込済み',
  rejected: '却下',
}

// 未対応＝これから経理が手を動かすもの。予約済みは進行中、振込済みは完了。
// 「今どれを見るべきか」が色で分かるようにする。
const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-info-subtle text-info',
  reserved: 'bg-warning-subtle text-warning',
  paid: 'bg-success-subtle text-success',
  rejected: 'bg-danger-subtle text-danger',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_CLASS[status] ?? 'bg-muted text-muted-foreground'
      )}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

// 受付日時はサーバー保存の UTC 文字列。閲覧端末のタイムゾーンに左右されないよう JST 固定で表示する。
function formatDateTime(iso: string): string {
  return formatInTimeZone(iso, TZ, 'M/d HH:mm')
}

// 読み取れなかった項目は空欄にせず「—」を出す。空欄だと「0円」「今日」などと読み違えられ、
// 原本を見に行くべき行だと気づけないため。
function formatAmount(amount: number | null): string {
  return amount === null ? '—' : `¥${amount.toLocaleString('ja-JP')}`
}

function formatDate(date: string | null): string {
  if (!date) return '—'
  const [y, m, d] = date.split('-').map(Number)
  return `${y}/${m}/${d}`
}

async function readErrorMessage(res: Response, fallback: string) {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return typeof data?.error === 'string' ? data.error : fallback
}

export default function PaymentCheckClient() {
  const [rows, setRows] = useState<PaymentRequestRow[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [extractingId, setExtractingId] = useState<string | null>(null)
  // 却下は「振り込まない」と決める操作で、一覧の既定表示からも消える。押し間違いを防ぐため確認を挟む。
  const [confirmTarget, setConfirmTarget] = useState<PaymentRequestRow | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/payment-requests${showAll ? '?status=all' : ''}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(await readErrorMessage(res, '一覧の取得に失敗しました。'))
      setRows((await res.json()) as PaymentRequestRow[])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '通信に失敗しました')
      setRows([])
    }
  }, [showAll])

  useEffect(() => { load() }, [load])

  async function changeStatus(row: PaymentRequestRow, status: PaymentRequestStatus) {
    setBusyId(row.id)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/payment-requests/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        setError(await readErrorMessage(res, '状態の更新に失敗しました。'))
        return
      }
      await load()
    } catch {
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    } finally {
      setBusyId(null)
    }
  }

  async function reExtract(row: PaymentRequestRow) {
    setExtractingId(row.id)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/payment-requests/${row.id}/extract`, { method: 'POST' })
      if (!res.ok) {
        setError(await readErrorMessage(res, '再読み取りに失敗しました。'))
        return
      }
      // 読み取り失敗は200＋error で返る（HTTPエラーだと理由が「通信に失敗しました」に丸められるため）。
      const outcome = (await res.json().catch(() => null)) as PaymentExtractOutcome | null
      if (outcome && 'error' in outcome) {
        setError(`「${row.file_name}」の再読み取りに失敗しました。${outcome.error}`)
      } else {
        setNotice(`「${row.file_name}」を読み取り直しました。`)
      }
      await load()
    } catch {
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    } finally {
      setExtractingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-bold">振込依頼チェック</h1>
        <p className="text-xs leading-relaxed text-muted-foreground">
          代表から届いた「振り込んでほしい請求書」です。振込先・金額・支払期日はAIが読み取った参考値なので、
          振り込む前に必ず「原本を開く」で現物をご確認ください。銀行で予約したら「振込予約済み」、
          実際に振り込まれたら「振込済み」にチェックを入れてください。
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground md:min-h-0">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => { setShowAll(e.target.checked); setRows(null) }}
            className="size-4"
          />
          振込済み・却下も表示する
        </label>
        <Button variant="outline" size="sm" className="h-11 md:h-7" onClick={() => load()}>
          再読み込み
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-info-subtle bg-info-subtle px-4 py-3 text-sm leading-relaxed text-info">
          {notice}
        </div>
      )}

      {!rows && (
        <div className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          読み込み中…
        </div>
      )}

      {rows && rows.length === 0 && !error && (
        <div className="rounded-lg border border-dashed bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          {showAll ? '受け付けた振込依頼はまだありません。' : '対応待ちの振込依頼はありません。'}
        </div>
      )}

      {rows?.map((row) => {
        const extracting = extractingId === row.id
        // 再読み取り中は読み取り結果が入れ替わる。古い金額を見たまま状態を進められないよう一緒に止める。
        const busy = busyId === row.id || extracting
        const failed = !!row.extract_error
        return (
          <div key={row.id} className="rounded-lg border bg-card">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium break-all">{row.file_name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatDateTime(row.created_at)} 受付
                  {row.reserved_at && `／${formatDateTime(row.reserved_at)} 予約`}
                  {row.paid_at && `／${formatDateTime(row.paid_at)} 振込`}
                  {row.rejected_at && `／${formatDateTime(row.rejected_at)} 却下`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {failed && (
                  <span className="inline-flex items-center rounded-full bg-danger-subtle px-2 py-0.5 text-xs font-medium whitespace-nowrap text-danger">
                    読み取り失敗
                  </span>
                )}
                <StatusBadge status={row.status} />
              </div>
            </div>

            {/* 失敗の理由はAIやネットワークが返した原文のまま出す。言い換えると
                「もう一度試せば直るのか」「原本を見て手で振り込むべきか」の判断材料が失われるため。 */}
            {row.extract_error && (
              <p className="border-b px-4 py-2 text-xs break-words text-danger">{row.extract_error}</p>
            )}

            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-3">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">振込先</dt>
                <dd className="break-words">{row.extracted_payee ?? '—'}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">金額</dt>
                <dd className="font-medium">{formatAmount(row.extracted_amount)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">支払期日</dt>
                <dd>{formatDate(row.extracted_due_date)}</dd>
              </div>
            </dl>

            {/* 代表のメモは期日や用途など、原本に書かれていない事情が入る唯一の欄なので必ず出す。 */}
            {row.note && (
              <div className="border-t px-4 py-3">
                <p className="text-xs text-muted-foreground">代表からのメモ</p>
                <p className="mt-1 text-sm break-words whitespace-pre-wrap">{row.note}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
              {/* 進み具合はチェックボックスで示す。押し間違えても外して戻せることが見た目から分かり、
                  「予約したか」「振り込んだか」の2つを1行で確かめられるため。 */}
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={row.status === 'reserved' || row.status === 'paid'}
                    disabled={busy || row.status === 'rejected'}
                    onChange={(e) => changeStatus(row, e.target.checked ? 'reserved' : 'pending')}
                  />
                  振込予約済み
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={row.status === 'paid'}
                    disabled={busy || row.status === 'rejected'}
                    // 振込済みを外したときは予約済みへ戻す。未対応まで一気に戻すと、
                    // 実際には残っている銀行の予約が画面から消えてしまう。
                    onChange={(e) => changeStatus(row, e.target.checked ? 'paid' : 'reserved')}
                  />
                  振込済み
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 md:h-7"
                  nativeButton={false}
                  render={<a href={`/api/payment-requests/${row.id}/file`} target="_blank" rel="noopener noreferrer" />}
                >
                  原本を開く
                </Button>
                {row.drive_link && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 md:h-7"
                    nativeButton={false}
                    render={<a href={row.drive_link} target="_blank" rel="noopener noreferrer" />}
                  >
                    ドライブで開く
                  </Button>
                )}
                {/* 読み取りに失敗した行は、経理が原本を見て手で振り込むしかない状態。
                    AI側の一時的な混雑が原因のことが多いので、まず叩き直せるようにする。 */}
                {failed && (
                  <Button size="sm" className="h-11 md:h-7" onClick={() => reExtract(row)} disabled={busy}>
                    {extracting ? '読み取り中…' : '再読み取り'}
                  </Button>
                )}
                {row.status === 'rejected' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 md:h-7"
                    onClick={() => changeStatus(row, 'pending')}
                    disabled={busy}
                  >
                    却下を取り消す
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 text-danger md:h-7"
                    onClick={() => setConfirmTarget(row)}
                    disabled={busy}
                  >
                    却下
                  </Button>
                )}
              </div>
            </div>
          </div>
        )
      })}

      <AlertDialog open={!!confirmTarget} onOpenChange={(open) => { if (!open) setConfirmTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>この振込依頼を却下しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {`「${confirmTarget?.file_name}」を却下します。振込は行われず、記録だけが残ります（あとで取り消せます）。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = confirmTarget
                setConfirmTarget(null)
                if (target) changeStatus(target, 'rejected')
              }}
            >
              却下する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
