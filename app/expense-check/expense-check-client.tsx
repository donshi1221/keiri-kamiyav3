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
import type { ExpenseUploadRow, ExpenseUploadItemRow } from '@/lib/ui-types'
import {
  EXPENSE_KIND_LABEL,
  formatExpenseAmount,
  formatExpenseDate,
  formatExpenseRoute,
} from '@/app/components/expense-format'

// 状態は text 列（enum ではない）なので、未知の値が入っていても画面が壊れないよう
// 対応表に無いときは値そのものを出す作りにする。
const STATUS_LABEL: Record<string, string> = {
  draft: '割当中',
  submitted: '送信済み',
  registered: '登録済み',
  rejected: '却下',
}

// 送信済み＝これから経理が判断するもの。登録済み・却下は処理済みなので、
// 「今どれを見るべきか」が色でわかるようにする。
const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  submitted: 'bg-info-subtle text-info',
  registered: 'bg-success-subtle text-success',
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

// 区分は「登録するとどこへ行く金額か」を表す。クライアントに請求する行だけが請求額に乗るので、
// その行だけ色を付けて、自社経費・対象外と一目で見分けられるようにする。
function KindLabel({ kind }: { kind: string | null }) {
  if (kind === null) return <span className="text-gray-400">未割当</span>
  const label = EXPENSE_KIND_LABEL[kind as keyof typeof EXPENSE_KIND_LABEL] ?? kind
  return <span className={cn('whitespace-nowrap', kind === 'client_billed' ? 'text-info' : 'text-gray-600')}>{label}</span>
}

// 受付・送信日時はサーバー保存の UTC 文字列。閲覧端末のタイムゾーンに左右されないよう JST 固定で表示する。
function formatDateTime(iso: string): string {
  return formatInTimeZone(iso, TZ, 'M/d HH:mm')
}

// 登録すると client_expenses に入り、そのままクライアントへの請求額になる金額。
// 押したあとでは戻せないため、ボタンの手前で必ず見えるようにする。
function billedTotal(items: ExpenseUploadItemRow[]): number {
  return items.filter((item) => item.kind === 'client_billed').reduce((sum, item) => sum + item.amount, 0)
}

async function readErrorMessage(res: Response, fallback: string) {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return typeof data?.error === 'string' ? data.error : fallback
}

export default function ExpenseCheckClient() {
  const [rows, setRows] = useState<ExpenseUploadRow[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // 登録は client_expenses を作る取り消せない操作、却下も状態を変える操作なので、
  // 一覧のボタンを押しただけでは実行せず、確認を挟む。
  const [confirmTarget, setConfirmTarget] = useState<{ row: ExpenseUploadRow; action: 'approve' | 'reject' } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/expense-uploads${showAll ? '?status=all' : ''}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(await readErrorMessage(res, '一覧の取得に失敗しました。'))
      setRows((await res.json()) as ExpenseUploadRow[])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '通信に失敗しました')
      setRows([])
    }
  }, [showAll])

  useEffect(() => { load() }, [load])

  // 409（登録済み・却下できない）や400（必須未入力の行）は、経理が次に何をすべきかを
  // サーバーの文言がそのまま説明している。言い換えず、そのまま画面に出す。
  async function review(id: string, action: 'approve' | 'reject') {
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch(`/api/expense-uploads/${id}/${action}`, { method: 'POST' })
      if (!res.ok) {
        setError(await readErrorMessage(res, action === 'approve' ? '登録に失敗しました。' : '却下に失敗しました。'))
        return
      }
      await load()
    } catch {
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-bold">経費チェック</h1>
        <p className="text-xs leading-relaxed text-gray-500">
          代表から届いた経費ファイルの明細です。「クライアントに請求」の行だけが、登録すると
          そのクライアントへの請求経費になります。自社経費・対象外の行は記録だけが残ります。
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <label className="flex min-h-11 items-center gap-2 text-sm text-gray-600 md:min-h-0">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => { setShowAll(e.target.checked); setRows(null) }}
            className="size-4"
          />
          登録済み・却下も表示する
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

      {!rows && (
        <div className="rounded-lg border bg-white px-4 py-10 text-center text-sm text-gray-500">
          読み込み中…
        </div>
      )}

      {rows && rows.length === 0 && !error && (
        <div className="rounded-lg border border-dashed bg-white px-4 py-10 text-center text-sm text-gray-500">
          {showAll ? '受け付けた経費ファイルはまだありません。' : '確認待ちの経費ファイルはありません。'}
        </div>
      )}

      {rows?.map((row) => {
        const total = billedTotal(row.items)
        const billedCount = row.items.filter((item) => item.kind === 'client_billed').length
        const busy = busyId === row.id
        return (
          <div key={row.id} className="rounded-lg border bg-white">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium break-all">{row.file_name}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {row.submitted_at ? `${formatDateTime(row.submitted_at)} 送信` : `${formatDateTime(row.created_at)} 受付`}
                  {row.reviewed_at && `／${formatDateTime(row.reviewed_at)} 処理`}
                </p>
              </div>
              <StatusBadge status={row.status} />
            </div>

            {row.extract_error && (
              <p className="border-b px-4 py-2 text-xs text-danger">{row.extract_error}</p>
            )}

            {/* 読み取りに失敗した受付は明細が1行も無い。表の枠だけが残ると壊れて見えるので、
                表・カードのどちらも出さずに理由だけを出す。 */}
            {row.items.length === 0 && (
              <p className="px-4 py-3 text-sm text-gray-500">明細はありません。</p>
            )}

            {/* 明細テーブル（PC・タブレット） */}
            <div className={cn('hidden overflow-x-auto', row.items.length > 0 && 'md:block')}>
              <table className="w-full min-w-[48rem] text-sm">
                <thead className="border-b bg-gray-50">
                  <tr>
                    <th className="w-[5rem] px-4 py-2 text-left font-medium whitespace-nowrap text-gray-600">利用日</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-gray-600">区間</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-gray-600">内容</th>
                    <th className="w-[7rem] px-3 py-2 text-right font-medium whitespace-nowrap text-gray-600">金額</th>
                    <th className="w-[9rem] px-3 py-2 text-left font-medium whitespace-nowrap text-gray-600">区分</th>
                    <th className="w-[10rem] px-3 py-2 text-left font-medium whitespace-nowrap text-gray-600">クライアント</th>
                    <th className="w-[11rem] px-3 py-2 text-left font-medium whitespace-nowrap text-gray-600">経費科目</th>
                  </tr>
                </thead>
                <tbody>
                  {row.items.map((item) => (
                    <tr key={item.id} className="border-b align-top last:border-0">
                      <td className="px-4 py-2 whitespace-nowrap text-gray-600">{formatExpenseDate(item.item_date)}</td>
                      <td className="px-3 py-2 text-gray-700">{formatExpenseRoute(item.from_place, item.to_place) || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{item.description ?? '—'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap text-gray-900">
                        {formatExpenseAmount(item.amount)}
                      </td>
                      <td className="px-3 py-2">
                        <KindLabel kind={item.kind} />
                        {/* 登録済みの行が分かると、途中で失敗した受付をどこから追えばよいかが判断できる。 */}
                        {item.registered_client_expense_id && (
                          <span className="ml-1 text-xs whitespace-nowrap text-success">登録済み</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-700">{item.client_name ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{item.category ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 明細カード（スマホ） */}
            <div className="divide-y md:hidden">
              {row.items.map((item) => (
                <div key={item.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{formatExpenseDate(item.item_date)}</p>
                      <p className="text-xs break-words text-gray-600">
                        {formatExpenseRoute(item.from_place, item.to_place) || item.description || '—'}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-medium">{formatExpenseAmount(item.amount)}</p>
                  </div>
                  <div className="mt-2 space-y-1 rounded-lg bg-gray-50 px-3 py-2 text-xs">
                    <div className="flex justify-between gap-3">
                      <span className="text-gray-500">区分</span>
                      <span className="text-right">
                        <KindLabel kind={item.kind} />
                        {item.registered_client_expense_id && <span className="ml-1 text-success">登録済み</span>}
                      </span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="shrink-0 text-gray-500">クライアント</span>
                      <span className="text-right text-gray-700">{item.client_name ?? '—'}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="shrink-0 text-gray-500">経費科目</span>
                      <span className="text-right text-gray-700">{item.category ?? '—'}</span>
                    </div>
                    {item.description && formatExpenseRoute(item.from_place, item.to_place) && (
                      <div className="flex justify-between gap-3">
                        <span className="shrink-0 text-gray-500">内容</span>
                        <span className="text-right text-gray-700">{item.description}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
              <div className="text-sm">
                <span className="text-gray-500">クライアントに請求</span>
                <span className="ml-2 font-medium text-info">{formatExpenseAmount(total)}</span>
                <span className="ml-1 text-xs text-gray-500">（{billedCount}件）</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 md:h-7"
                  nativeButton={false}
                  render={<a href={`/api/expense-uploads/${row.id}/file`} target="_blank" rel="noopener noreferrer" />}
                >
                  原本を開く
                </Button>
                {/* 代表がまだ送信していない受付（割当中）は、割り当てが変わる可能性があるので判断させない。 */}
                {row.status === 'submitted' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11 text-danger md:h-7"
                      onClick={() => setConfirmTarget({ row, action: 'reject' })}
                      disabled={busy}
                    >
                      却下
                    </Button>
                    <Button
                      size="sm"
                      className="h-11 md:h-7"
                      onClick={() => setConfirmTarget({ row, action: 'approve' })}
                      disabled={busy}
                    >
                      {busy ? '処理中…' : '登録する'}
                    </Button>
                  </>
                )}
                {row.status === 'draft' && <span className="text-xs text-gray-500">代表が割当中です</span>}
              </div>
            </div>
          </div>
        )
      })}

      <AlertDialog open={!!confirmTarget} onOpenChange={(open) => { if (!open) setConfirmTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmTarget?.action === 'approve' ? 'この経費を登録しますか？' : 'この経費を却下しますか？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget?.action === 'approve'
                ? `「${confirmTarget.row.file_name}」のうち「クライアントに請求」の明細 ${formatExpenseAmount(billedTotal(confirmTarget.row.items))} を請求経費として登録します。登録後は取り消せません。`
                : `「${confirmTarget?.row.file_name}」を却下します。経費としては登録されず、記録だけが残ります。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmTarget?.action === 'approve' ? 'default' : 'destructive'}
              onClick={() => {
                const target = confirmTarget
                setConfirmTarget(null)
                if (target) review(target.row.id, target.action)
              }}
            >
              {confirmTarget?.action === 'approve' ? '登録する' : '却下する'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
