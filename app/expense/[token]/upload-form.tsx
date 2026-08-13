'use client'

import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { EXPENSE_CATEGORIES, EXPENSE_ITEM_KINDS } from '@/lib/config'
import type { Client, ExpenseUploadItem } from '@/lib/schema'
import type {
  ExpenseCategory,
  ExpenseInboxResponse,
  ExpenseItemAssignment,
  ExpenseItemKind,
} from '@/lib/ui-types'
import {
  EXPENSE_KIND_LABEL,
  formatExpenseAmount,
  formatExpenseDate,
  formatExpenseRoute,
} from '@/app/components/expense-format'

// 入力の途中は「まだ選んでいない」状態を持てないと困る（初期表示が必ず未選択のため）。
// 送信用の型（ExpenseItemAssignment）は選択済みを前提にした形なので、画面の下書きは空文字を許す形で別に持つ。
type ItemDraft = {
  kind: ExpenseItemKind | ''
  clientId: string
  category: ExpenseCategory | ''
}

const EMPTY_DRAFT: ItemDraft = { kind: '', clientId: '', category: '' }

// 送信できる状態か。サーバー側の検証（lib/validation の expenseItemAssignSchema）と同じ条件にして、
// 画面では通るのに送信で弾かれる、という食い違いを避ける。
function isComplete(draft: ItemDraft): boolean {
  if (draft.kind === '') return false
  if (draft.kind === 'excluded') return true
  if (draft.category === '') return false
  return draft.kind !== 'client_billed' || draft.clientId !== ''
}

async function readErrorMessage(res: Response, fallback: string) {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return typeof data?.error === 'string' ? data.error : fallback
}

// 区分・クライアント・経費科目の3つを選ぶ部品。1行ごとの割り当てと「まとめて設定」で同じものを使う。
// クライアントは「クライアントに請求」のときだけ、経費科目は「対象外」以外のときだけ出す。
// 区分が未選択のうちに後続の欄を出すと、スマホの狭い画面で意味のない欄が場所を取るため出さない。
function AssignFields({
  draft,
  clients,
  onChange,
  idPrefix,
}: {
  draft: ItemDraft
  clients: Pick<Client, 'id' | 'name'>[]
  onChange: (next: ItemDraft) => void
  idPrefix: string
}) {
  // スマホでの取りこぼしを防ぐため、選択欄の高さは44px以上を確保する（PCは詰めた高さに戻す）。
  const selectClass = 'min-h-11 w-full rounded border bg-white px-3 py-2 text-sm md:min-h-9'

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={`${idPrefix}-kind`} className="mb-1 block text-xs font-medium text-gray-600">
          区分
        </label>
        <select
          id={`${idPrefix}-kind`}
          value={draft.kind}
          onChange={(e) => onChange({ ...draft, kind: e.target.value as ItemDraft['kind'] })}
          className={selectClass}
        >
          <option value="">選択してください</option>
          {EXPENSE_ITEM_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {EXPENSE_KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </div>

      {draft.kind === 'client_billed' && (
        <div>
          <label htmlFor={`${idPrefix}-client`} className="mb-1 block text-xs font-medium text-gray-600">
            クライアント
          </label>
          <select
            id={`${idPrefix}-client`}
            value={draft.clientId}
            onChange={(e) => onChange({ ...draft, clientId: e.target.value })}
            className={selectClass}
          >
            <option value="">選択してください</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {(draft.kind === 'client_billed' || draft.kind === 'company') && (
        <div>
          <label htmlFor={`${idPrefix}-category`} className="mb-1 block text-xs font-medium text-gray-600">
            経費科目
          </label>
          <select
            id={`${idPrefix}-category`}
            value={draft.category}
            onChange={(e) => onChange({ ...draft, category: e.target.value as ItemDraft['category'] })}
            className={selectClass}
          >
            <option value="">選択してください</option>
            {EXPENSE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

export default function ExpenseUploadForm({
  token,
  clients,
}: {
  token: string
  clients: Pick<Client, 'id' | 'name'>[]
}) {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [inbox, setInbox] = useState<ExpenseInboxResponse | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({})
  const [bulk, setBulk] = useState<ItemDraft>(EMPTY_DRAFT)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const items = inbox?.items ?? []

  // モバイルICOCAは往復が2行に分かれるなど、同じ日の行がひと続きの用事になっていることが多い。
  // 日付でまとめて見せることで、1件ずつ確かめなくても「この日はこの用事」と判断できるようにする。
  const groups = useMemo(() => {
    const map = new Map<string, ExpenseUploadItem[]>()
    for (const item of items) {
      const key = item.item_date ?? ''
      const rows = map.get(key)
      if (rows) rows.push(item)
      else map.set(key, [item])
    }
    return Array.from(map, ([date, rows]) => ({ date, rows }))
  }, [items])

  const incomplete = items.filter((item) => !isComplete(drafts[item.id] ?? EMPTY_DRAFT))

  function updateDraft(id: string, next: ItemDraft) {
    setDrafts((prev) => ({ ...prev, [id]: next }))
  }

  // 同じ出張のファイルは全行が同じ割り当てになることが多いため、1回の操作で全行を埋められるようにする。
  function applyToAll(draft: ItemDraft) {
    setDrafts(Object.fromEntries(items.map((item) => [item.id, { ...draft }])))
  }

  // ある行の選択を同じ日の行へ配る。往復2行を1件ずつ選ぶ手間をなくすのが目的。
  function applyToDate(date: string, draft: ItemDraft) {
    setDrafts((prev) => {
      const next = { ...prev }
      for (const item of items) {
        if ((item.item_date ?? '') === date) next[item.id] = { ...draft }
      }
      return next
    })
  }

  async function sendFile(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    setError('')

    const body = new FormData()
    body.append('token', token)
    body.append('file', file)

    try {
      const res = await fetch('/api/expense-inbox', { method: 'POST', body })
      setUploading(false)
      if (!res.ok) {
        setError(await readErrorMessage(res, 'アップロードに失敗しました。時間をおいて再度お試しください。'))
        return
      }
      const data = (await res.json()) as ExpenseInboxResponse
      setInbox(data)
      setDrafts(Object.fromEntries(data.items.map((item) => [item.id, EMPTY_DRAFT])))
      setBulk(EMPTY_DRAFT)
    } catch {
      // 通信断でも fetch は例外になる。戻さないと「読み取っています…」でボタンが固着する。
      setUploading(false)
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  async function submitAssignments() {
    if (!inbox || incomplete.length > 0) return
    setSubmitting(true)
    setError('')

    // 「対象外」の行にクライアント・科目を付けたまま送らない。選び直しの途中経過が
    // そのまま経理に見えると、請求するのかどうかが読めなくなるため。
    const payload: ExpenseItemAssignment[] = inbox.items.map((item) => {
      const draft = drafts[item.id] ?? EMPTY_DRAFT
      return {
        id: item.id,
        kind: draft.kind as ExpenseItemKind,
        client_id: draft.kind === 'client_billed' ? draft.clientId : null,
        category: draft.kind === 'excluded' || draft.category === '' ? null : draft.category,
      }
    })

    try {
      const res = await fetch(`/api/expense-inbox/${inbox.id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, items: payload }),
      })
      setSubmitting(false)
      if (!res.ok) {
        setError(await readErrorMessage(res, '送信に失敗しました。時間をおいて再度お試しください。'))
        return
      }
      setDone(true)
    } catch {
      setSubmitting(false)
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  function reset() {
    setFile(null)
    setInbox(null)
    setDrafts({})
    setBulk(EMPTY_DRAFT)
    setDone(false)
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  if (done) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-success bg-success-subtle px-4 py-3 text-sm text-success">
          送信しました。経理の確認をお待ちください。
        </div>
        <Button type="button" variant="outline" className="h-11 w-full" onClick={reset}>
          続けて別のファイルを送る
        </Button>
      </div>
    )
  }

  // ─── 第1段階: ファイルを選んで送る ───────────────────────────────
  if (!inbox) {
    return (
      <form onSubmit={sendFile} className="space-y-4">
        <p className="text-sm text-gray-600">
          モバイルICOCAの利用履歴（PDF）や領収書の写真を1つ選んで送信してください。
          送信すると明細を読み取るので、続けて行ごとの割り当てをお願いします。
        </p>

        <div>
          <label htmlFor="expense-file" className="mb-1 block text-sm font-medium">
            経費のファイル（PDF・写真）
          </label>
          <input
            id="expense-file"
            ref={inputRef}
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setError('')
            }}
            className="w-full rounded border px-3 py-2.5 text-sm file:mr-3 file:min-h-11 file:rounded file:border-0 file:bg-primary file:px-3 file:text-sm file:text-primary-foreground"
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" className="h-11 w-full" disabled={!file || uploading}>
          {uploading ? '読み取っています…' : '送信する'}
        </Button>

        {/* AIの読み取りには十数秒かかることがある。何も出ないと固まったように見えて
            画面を閉じられてしまうため、待ち時間であることを明示する。 */}
        {uploading && (
          <p className="text-center text-xs text-gray-500">
            明細を読み取っています。1分ほどかかることがあります。このまま画面を開いたままお待ちください。
          </p>
        )}
      </form>
    )
  }

  // ─── 読み取りに失敗した場合 ───────────────────────────────
  // 原因はファイルの中身やAI側の都合で、代表の操作では解決できない。同じファイルを送り直しても
  // 同じ結果になるため、再送は促さず担当者への連絡だけを案内する（ファイル自体は預かり済み）。
  if (inbox.extract_error || items.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger">
          <p className="font-medium">明細を読み取れませんでした</p>
          <p className="mt-1">
            ファイル（{inbox.file_name}）はお預かりしました。お手数ですが担当者にご連絡ください。
          </p>
        </div>
        {inbox.extract_error && <p className="text-xs text-gray-500">{inbox.extract_error}</p>}
      </div>
    )
  }

  // ─── 第2段階: 読み取った明細に割り当てる ───────────────────────────────
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-white px-4 py-3">
        <p className="text-sm font-medium break-all">{inbox.file_name}</p>
        <p className="mt-1 text-xs text-gray-500">
          {items.length}件の明細を読み取りました。行ごとに区分などを選んで送信してください。
        </p>
      </div>

      {/* 1ファイルが同じクライアントの出張で埋まることが多いため、全行を一度に埋める入口を先頭に置く。 */}
      <div className="rounded-lg border border-info-subtle bg-info-subtle px-4 py-3">
        <p className="text-sm font-medium text-info">まとめて設定</p>
        <p className="mt-1 mb-2 text-xs text-info">
          全部の行が同じ内容なら、ここで選んで一括で当てはめられます。あとから行ごとに直せます。
        </p>
        <AssignFields draft={bulk} clients={clients} onChange={setBulk} idPrefix="bulk" />
        <Button
          type="button"
          className="mt-3 h-11 w-full md:h-9"
          onClick={() => applyToAll(bulk)}
          disabled={!isComplete(bulk)}
        >
          全{items.length}件に適用
        </Button>
      </div>

      {groups.map((group) => (
        <div key={group.date || 'no-date'} className="space-y-2">
          <div className="flex items-baseline justify-between gap-2 px-1">
            <h2 className="text-sm font-bold">{formatExpenseDate(group.date || null)}</h2>
            <span className="text-xs text-gray-500">
              {group.rows.length}件 / {formatExpenseAmount(group.rows.reduce((sum, r) => sum + r.amount, 0))}
            </span>
          </div>

          {group.rows.map((item) => {
            const draft = drafts[item.id] ?? EMPTY_DRAFT
            const route = formatExpenseRoute(item.from_place, item.to_place)
            const complete = isComplete(draft)
            return (
              <div
                key={item.id}
                className={cn(
                  'rounded-lg border bg-white px-4 py-3',
                  // 未入力の行は「これから埋めるもの」なので、エラーの赤ではなく注意の色で目立たせる。
                  !complete && 'border-warning/40 bg-warning-subtle'
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {route && <p className="text-sm font-medium break-words">{route}</p>}
                    <p className={cn('text-xs text-gray-600', !route && 'text-sm font-medium text-gray-900')}>
                      {item.description ?? '内容なし'}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-medium">{formatExpenseAmount(item.amount)}</p>
                </div>

                <div className="mt-3">
                  <AssignFields
                    draft={draft}
                    clients={clients}
                    onChange={(next) => updateDraft(item.id, next)}
                    idPrefix={`item-${item.id}`}
                  />
                </div>

                {/* 往復が2行に分かれるため、同じ日の行へ配れるようにする。1行分を選び終えてから押す操作なので、
                    その行が埋まるまでは押せないようにする。 */}
                {group.rows.length > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2 h-11 w-full md:h-9"
                    onClick={() => applyToDate(group.date, draft)}
                    disabled={!complete}
                  >
                    この日の{group.rows.length}件に適用
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      ))}

      {error && (
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {/* 明細が10件前後あると送信ボタンが画面外に出てしまう。残り件数と一緒に手元へ固定して、
          「あと何行埋めればよいか」を見ながら送信できるようにする。 */}
      <div className="sticky bottom-4 rounded-lg border bg-white px-4 py-3 shadow-lg">
        {incomplete.length > 0 && (
          <p className="mb-2 text-center text-xs text-warning">未入力があと{incomplete.length}件あります</p>
        )}
        <Button
          type="button"
          className="h-11 w-full"
          onClick={submitAssignments}
          disabled={submitting || incomplete.length > 0}
        >
          {submitting ? '送信中…' : '送信する'}
        </Button>
      </div>
    </div>
  )
}
