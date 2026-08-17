'use client'

import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { EXPENSE_ITEM_KINDS } from '@/lib/config'
import type { Client, ExpenseUploadItem } from '@/lib/schema'
import type {
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
}

const EMPTY_DRAFT: ItemDraft = { kind: '', clientId: '' }

// 1ファイル分の処理結果。最後の一覧で「どれが経理に届いて、どれが届いていないか」を
// 代表がその場で把握できないと、失敗分だけを担当者に伝えることができない。
type FileResult = {
  name: string
  status: 'submitted' | 'extract_failed' | 'upload_failed'
  message?: string
}

// アップロードは失敗しても例外にせず、理由を持ち回る（先読みした Promise を後から受け取るため、
// 投げっぱなしの例外だと受け取る側で拾いようがない）。
type UploadOutcome = { ok: true; data: ExpenseInboxResponse } | { ok: false; error: string }

// 送信できる状態か。サーバー側の検証（lib/validation の expenseItemAssignSchema）と同じ条件にして、
// 画面では通るのに送信で弾かれる、という食い違いを避ける。
function isComplete(draft: ItemDraft): boolean {
  if (draft.kind === '') return false
  return draft.kind !== 'client_billed' || draft.clientId !== ''
}

async function readErrorMessage(res: Response, fallback: string) {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return typeof data?.error === 'string' ? data.error : fallback
}

// 区分・クライアントの2つを選ぶ部品。明細1行ごとの割り当てに使う。
// クライアントは「クライアントに請求」のときだけ出す。区分が未選択のうちに後続の欄を出すと、
// スマホの狭い画面で意味のない欄が場所を取るため出さない。
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
  const selectClass = 'min-h-11 w-full rounded border bg-card px-3 py-2 text-sm md:min-h-9'

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={`${idPrefix}-kind`} className="mb-1 block text-xs font-medium text-muted-foreground">
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
          <label htmlFor={`${idPrefix}-client`} className="mb-1 block text-xs font-medium text-muted-foreground">
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
  const [files, setFiles] = useState<File[]>([])
  // 選択中の画面（select）→ 1件ずつ割り当て（working）→ 結果一覧（done）の3段階。
  const [phase, setPhase] = useState<'select' | 'working' | 'done'>('select')
  const [index, setIndex] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [inbox, setInbox] = useState<ExpenseInboxResponse | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({})
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<FileResult[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  // 先読み中の1件。描画に使わない（表示は結果を受け取ってから）ので state ではなく ref で持つ。
  const prefetchRef = useRef<{ index: number; promise: Promise<UploadOutcome> } | null>(null)

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

  async function uploadOne(target: File): Promise<UploadOutcome> {
    const body = new FormData()
    body.append('token', token)
    body.append('file', target)

    try {
      const res = await fetch('/api/expense-inbox', { method: 'POST', body })
      if (!res.ok) {
        return { ok: false, error: await readErrorMessage(res, 'アップロードに失敗しました。時間をおいて再度お試しください。') }
      }
      return { ok: true, data: (await res.json()) as ExpenseInboxResponse }
    } catch {
      // 通信断でも fetch は例外になる。理由を返さないと「読み取っています…」の表示から抜けられない。
      return { ok: false, error: '通信に失敗しました。接続を確認して再度お試しください。' }
    }
  }

  // 割り当ての操作中に次の1件をAIへ回しておくと、次の画面がほぼ待ち時間なしで出る。
  // 先読みは必ず「次の1つ」だけにする。全件を一度に投げると、AI読み取りの無料枠を一気に使い切り、
  // 受付APIの制限時間（60秒）にも同時実行がぶつかって、まとめて失敗しかねないため。
  function startPrefetch(nextIndex: number, list: File[]) {
    const next = list[nextIndex]
    prefetchRef.current = next ? { index: nextIndex, promise: uploadOne(next) } : null
  }

  function recordResult(result: FileResult) {
    setResults((prev) => [...prev, result])
  }

  // 指定の1件を画面に出す。先読み済みならその結果を待つだけで済む。
  async function openFile(target: number, list: File[]) {
    const file = list[target]
    if (!file) return

    setUploading(true)
    setError('')
    setUploadError('')
    setInbox(null)
    setDrafts({})

    const prefetched = prefetchRef.current
    const pending = prefetched?.index === target ? prefetched.promise : uploadOne(file)
    prefetchRef.current = null

    const outcome = await pending
    setUploading(false)
    setPhase('working')

    if (!outcome.ok) {
      setUploadError(outcome.error)
      recordResult({ name: file.name, status: 'upload_failed', message: outcome.error })
    } else {
      setInbox(outcome.data)
      setDrafts(Object.fromEntries(outcome.data.items.map((item) => [item.id, EMPTY_DRAFT])))
      // 失敗はこの時点で記録する。代表が「次のファイルへ」を押さずに画面を離れても、
      // 直前まで見ていた結果一覧に失敗が残っている方が担当者へ伝えやすい。
      if (outcome.data.extract_error || outcome.data.items.length === 0) {
        recordResult({
          name: outcome.data.file_name,
          status: 'extract_failed',
          message: outcome.data.extract_error ?? '明細が1件も読み取れませんでした',
        })
      }
    }

    startPrefetch(target + 1, list)
  }

  async function start(e: React.FormEvent) {
    e.preventDefault()
    if (files.length === 0) return
    setIndex(0)
    setResults([])
    await openFile(0, files)
  }

  async function goNext() {
    const next = index + 1
    if (next >= files.length) {
      setInbox(null)
      setPhase('done')
      return
    }
    setIndex(next)
    await openFile(next, files)
  }

  async function submitAssignments() {
    if (!inbox || incomplete.length > 0) return
    setSubmitting(true)
    setError('')

    // 「対象外」の行にクライアントを付けたまま送らない。選び直しの途中経過が
    // そのまま経理に見えると、請求するのかどうかが読めなくなるため。
    const payload: ExpenseItemAssignment[] = inbox.items.map((item) => {
      const draft = drafts[item.id] ?? EMPTY_DRAFT
      return {
        id: item.id,
        kind: draft.kind as ExpenseItemKind,
        client_id: draft.kind === 'client_billed' ? draft.clientId : null,
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
      recordResult({ name: inbox.file_name, status: 'submitted' })
      await goNext()
    } catch {
      setSubmitting(false)
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  function reset() {
    setFiles([])
    setPhase('select')
    setIndex(0)
    setInbox(null)
    setDrafts({})
    setResults([])
    setError('')
    setUploadError('')
    prefetchRef.current = null
    if (inputRef.current) inputRef.current.value = ''
  }

  const isLast = index >= files.length - 1
  const currentName = files[index]?.name ?? ''

  // 複数選んだときだけ進み具合を出す。1件だけのときは分母が常に1で、かえって読む手間が増えるため。
  const progress =
    files.length > 1 ? (
      <p className="text-xs font-medium text-muted-foreground">
        {index + 1}/{files.length}件目：<span className="break-all">{currentName}</span>
      </p>
    ) : null

  const nextButton = (
    <Button type="button" variant="outline" className="h-11 w-full" onClick={goNext}>
      {isLast ? '結果を見る' : '次のファイルへ'}
    </Button>
  )

  // ─── 最終段階: ファイルごとの結果 ───────────────────────────────
  if (phase === 'done') {
    const failed = results.filter((r) => r.status !== 'submitted')
    return (
      <div className="space-y-4">
        {failed.length === 0 ? (
          <div className="rounded-lg border border-success bg-success-subtle px-4 py-3 text-sm text-success">
            送信しました。経理の確認をお待ちください。
          </div>
        ) : (
          <div className="rounded-lg border border-warning bg-warning-subtle px-4 py-3 text-sm text-warning">
            <p className="font-medium">{failed.length}件のファイルを送信できませんでした</p>
            <p className="mt-1">ファイル自体はお預かりしています。お手数ですが担当者にご連絡ください。</p>
          </div>
        )}

        {results.length > 1 && (
          <div className="divide-y rounded-lg border bg-card">
            {results.map((result, i) => (
              <div key={`${result.name}-${i}`} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm break-all">{result.name}</p>
                  {result.message && <p className="mt-1 text-xs text-muted-foreground break-all">{result.message}</p>}
                </div>
                <p
                  className={cn(
                    'shrink-0 text-xs font-medium',
                    result.status === 'submitted' ? 'text-success' : 'text-danger'
                  )}
                >
                  {result.status === 'submitted'
                    ? '送信済み'
                    : result.status === 'extract_failed'
                      ? '読み取り失敗'
                      : 'アップロード失敗'}
                </p>
              </div>
            ))}
          </div>
        )}

        <Button type="button" variant="outline" className="h-11 w-full" onClick={reset}>
          続けて別のファイルを送る
        </Button>
      </div>
    )
  }

  // ─── 第1段階: ファイルを選んで送る ───────────────────────────────
  if (phase === 'select') {
    return (
      <form onSubmit={start} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          モバイルICOCAの利用履歴（PDF）や領収書の写真を選んで送信してください。まとめて選べます。
          送信すると1件ずつ明細を読み取るので、続けて行ごとの割り当てをお願いします。
        </p>

        <div>
          <label htmlFor="expense-file" className="mb-1 block text-sm font-medium">
            経費のファイル（PDF・写真）
          </label>
          <input
            id="expense-file"
            ref={inputRef}
            type="file"
            multiple
            accept="application/pdf,image/*"
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []))
              setError('')
            }}
            className="w-full rounded border px-3 py-2.5 text-sm file:mr-3 file:min-h-11 file:rounded file:border-0 file:bg-primary file:px-3 file:text-sm file:text-primary-foreground"
          />
        </div>

        {/* 端末によっては入力欄に「3個のファイル」としか出ず、選び間違いに気付けない。
            開始前に名前を並べて、送る中身を確かめられるようにする。 */}
        {files.length > 0 && (
          <div className="rounded-lg border bg-card px-4 py-3">
            <p className="text-xs font-medium text-muted-foreground">選んだファイル：{files.length}件</p>
            <ol className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="text-sm break-all">
                  {i + 1}. {f.name}
                </li>
              ))}
            </ol>
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" className="h-11 w-full" disabled={files.length === 0 || uploading}>
          {uploading ? '読み取っています…' : '送信する'}
        </Button>

        {/* AIの読み取りには十数秒かかることがある。何も出ないと固まったように見えて
            画面を閉じられてしまうため、待ち時間であることを明示する。 */}
        {uploading && (
          <p className="text-center text-xs text-muted-foreground">
            明細を読み取っています。1分ほどかかることがあります。このまま画面を開いたままお待ちください。
          </p>
        )}
      </form>
    )
  }

  // ─── 次のファイルの読み取り待ち ───────────────────────────────
  // 先読みが間に合っていれば一瞬で次へ進むが、間に合わなかった場合はここで待つことになる。
  if (uploading) {
    return (
      <div className="space-y-3">
        {progress}
        <div className="rounded-lg border bg-card px-4 py-6 text-center">
          <p className="text-sm font-medium">明細を読み取っています…</p>
          <p className="mt-1 text-xs text-muted-foreground">
            1分ほどかかることがあります。このまま画面を開いたままお待ちください。
          </p>
        </div>
      </div>
    )
  }

  // ─── アップロード自体に失敗した場合 ───────────────────────────────
  // このファイルは預かれていないので、担当者に別途渡してもらう必要がある。残りのファイルは続けられる。
  if (uploadError) {
    return (
      <div className="space-y-4">
        {progress}
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger">
          <p className="font-medium">このファイルを送れませんでした</p>
          <p className="mt-1 break-all">{currentName}</p>
          <p className="mt-1">{uploadError}</p>
        </div>
        {nextButton}
      </div>
    )
  }

  if (!inbox) return null

  // ─── 読み取りに失敗した場合 ───────────────────────────────
  // 原因はファイルの中身やAI側の都合で、代表の操作では解決できない。同じファイルを送り直しても
  // 同じ結果になるため、再送は促さず担当者への連絡だけを案内する（ファイル自体は預かり済み）。
  if (inbox.extract_error || items.length === 0) {
    return (
      <div className="space-y-4">
        {progress}
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger">
          <p className="font-medium">明細を読み取れませんでした</p>
          <p className="mt-1">
            ファイル（{inbox.file_name}）はお預かりしました。お手数ですが担当者にご連絡ください。
          </p>
        </div>
        {inbox.extract_error && <p className="text-xs text-muted-foreground">{inbox.extract_error}</p>}
        {nextButton}
      </div>
    )
  }

  // ─── 第2段階: 読み取った明細に割り当てる ───────────────────────────────
  return (
    <div className="space-y-4">
      {progress}
      <div className="rounded-lg border bg-card px-4 py-3">
        <p className="text-sm font-medium break-all">{inbox.file_name}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {items.length}件の明細を読み取りました。行ごとに区分などを選んで送信してください。
        </p>
      </div>

      {groups.map((group) => (
        <div key={group.date || 'no-date'} className="space-y-2">
          <div className="flex items-baseline justify-between gap-2 px-1">
            <h2 className="text-sm font-bold">{formatExpenseDate(group.date || null)}</h2>
            <span className="text-xs text-muted-foreground">
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
                  'rounded-lg border bg-card px-4 py-3',
                  // 未入力の行は「これから埋めるもの」なので、エラーの赤ではなく注意の色で目立たせる。
                  !complete && 'border-warning/40 bg-warning-subtle'
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {route && <p className="text-sm font-medium break-words">{route}</p>}
                    <p className={cn('text-xs text-muted-foreground', !route && 'text-sm font-medium text-foreground')}>
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
                    同日の明細に適用
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
      <div className="sticky bottom-4 rounded-lg border bg-card px-4 py-3 shadow-lg">
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
