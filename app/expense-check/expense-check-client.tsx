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
import { TZ, addMonthsOf, nextMonthOf } from '@/lib/dates'
import type {
  ExpenseUploadRow,
  ExpenseUploadItemRow,
  ExpenseExtractOutcome,
  ExpenseApproveResult,
  ExpenseRejectResult,
  GoogleDriveStatus,
} from '@/lib/ui-types'
import {
  EXPENSE_KIND_LABEL,
  formatExpenseAmount,
  formatExpenseDate,
  formatExpenseRoute,
} from '@/app/components/expense-format'

// 状態は text 列（enum ではない）なので、未知の値が入っていても画面が壊れないよう
// 対応表に無いときは値そのものを出す作りにする。
// extract_failed はDBには無い、画面だけの区分（draft かつ読み取りエラーあり）。
// 同じ draft でも「代表が割当中」と「AIが読めずに止まっている」では経理のすべきことが正反対なので、
// 一覧で見分けられるように分けている。
const EXTRACT_FAILED = 'extract_failed'

const STATUS_LABEL: Record<string, string> = {
  draft: '割当中',
  submitted: '送信済み',
  registered: '登録済み',
  rejected: '却下',
  [EXTRACT_FAILED]: '読み取り失敗',
}

// 送信済み＝これから経理が判断するもの。登録済み・却下は処理済みなので、
// 「今どれを見るべきか」が色でわかるようにする。
// 読み取り失敗は放置すると誰も先へ進めない行き止まりなので、却下と同じ危険色で目立たせる。
const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  submitted: 'bg-info-subtle text-info',
  registered: 'bg-success-subtle text-success',
  rejected: 'bg-danger-subtle text-danger',
  [EXTRACT_FAILED]: 'bg-danger-subtle text-danger',
}

// 読み取りに失敗して止まっている受付か。バッジ・説明文・操作ボタンの出し分けを1か所で決める。
function isExtractFailed(row: ExpenseUploadRow): boolean {
  return row.status === 'draft' && !!row.extract_error
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
  if (kind === null) return <span className="text-muted-foreground">未割当</span>
  const label = EXPENSE_KIND_LABEL[kind as keyof typeof EXPENSE_KIND_LABEL] ?? kind
  return <span className={cn('whitespace-nowrap', kind === 'client_billed' ? 'text-info' : 'text-muted-foreground')}>{label}</span>
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

// 請求月の選択肢は「利用月・翌月・翌々月」の3択。基本は翌月に乗せる運用だが、
// 締めに間に合わない利用分を翌々月へ回す・利用月にそのまま乗せる、といった調整が実際に起きるため、
// 登録の直前に経理がその場で選べるようにする（範囲の正本はAPI側にも同じものがある）。
const BILLING_MONTH_OFFSETS = [0, 1, 2]

type BillingMonth = { year: number; month: number }

// 請求月を選べる明細か。利用日が無い行は基準の月が決まらない（登録時にもエラーで弾かれる）ため出さない。
function isBillableItem(item: ExpenseUploadItemRow): boolean {
  return item.kind === 'client_billed' && !!item.item_date
}

function billingMonthOptions(itemDate: string): BillingMonth[] {
  const year = Number(itemDate.slice(0, 4))
  const month = Number(itemDate.slice(5, 7))
  return BILLING_MONTH_OFFSETS.map((offset) => addMonthsOf(year, month, offset))
}

// 未選択の行は現行ルール（翌月）のまま登録される。既定を明示しておくことで、
// 画面に出ている月とサーバーが使う月が必ず一致する。
function defaultBillingMonth(itemDate: string): BillingMonth {
  return nextMonthOf(Number(itemDate.slice(0, 4)), Number(itemDate.slice(5, 7)))
}

function billingMonthLabel(m: BillingMonth): string {
  return `${m.year}年${m.month}月分`
}

// select の value は文字列しか持てないため、年月を1つのキーに畳んで往復させる。
function billingMonthKey(m: BillingMonth): string {
  return `${m.year}-${m.month}`
}

// 立替精算（代表へ返すお金）に乗せられる明細か。「対象外」はどこにも計上しない区分なので、
// 返金の対象にもならない。クライアント請求分・自社経費分はどちらも代表が立て替えていれば返す。
function isReimbursableItem(item: ExpenseUploadItemRow): boolean {
  return item.kind !== null && item.kind !== 'excluded'
}

async function readErrorMessage(res: Response, fallback: string) {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return typeof data?.error === 'string' ? data.error : fallback
}

export default function ExpenseCheckClient() {
  const [rows, setRows] = useState<ExpenseUploadRow[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 再読み取りに成功した受付は「代表の割当待ち（draft）」に戻り、既定の一覧から消える。
  // 消えた理由と次に誰が何をするのかを伝えないと「操作が効かなかった」ように見えるため、
  // エラーとは別枠の案内として出す。
  const [notice, setNotice] = useState<string | null>(null)
  const [driveConfigured, setDriveConfigured] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [extractingId, setExtractingId] = useState<string | null>(null)
  // 登録は client_expenses を作る取り消せない操作、却下も状態を変える操作なので、
  // 一覧のボタンを押しただけでは実行せず、確認を挟む。
  const [confirmTarget, setConfirmTarget] = useState<{ row: ExpenseUploadRow; action: 'approve' | 'reject' } | null>(null)
  // 明細ID => 経理が選んだ請求月。選んでいない行はここに入らず、既定（翌月）で登録される。
  // 受付をまたいで持てるよう受付単位ではなく明細IDで持つ（IDは受付をまたいで一意）。
  const [billingMonths, setBillingMonths] = useState<Record<string, BillingMonth>>({})
  // 明細ID => 立替精算に含めるか。既定はON（代表が自分の財布から払っているのが通常のため）で、
  // 会社カード決済など返金の要らない明細だけを経理が外す。ここに入っていない行はONとして扱う。
  const [reimburse, setReimburse] = useState<Record<string, boolean>>({})

  function resolveBillingMonth(item: ExpenseUploadItemRow): BillingMonth {
    return billingMonths[item.id] ?? defaultBillingMonth(item.item_date!)
  }

  function isReimburseChecked(item: ExpenseUploadItemRow): boolean {
    return reimburse[item.id] ?? true
  }

  // 表とカードで同じチェックボックスを出すため、見た目と挙動をここに1つだけ持つ。
  function renderReimburseCheckbox(item: ExpenseUploadItemRow, disabled: boolean) {
    return (
      <label className="flex min-h-11 items-center gap-2 md:min-h-0">
        <input
          type="checkbox"
          aria-label="立替精算に含める"
          checked={isReimburseChecked(item)}
          disabled={disabled}
          onChange={(e) => setReimburse((prev) => ({ ...prev, [item.id]: e.target.checked }))}
          className="size-4"
        />
        <span className="text-xs text-muted-foreground md:hidden">立替精算に含める</span>
      </label>
    )
  }

  // 表とカードで同じプルダウンを出すため、見た目と挙動をここに1つだけ持つ。
  function renderBillingMonthSelect(item: ExpenseUploadItemRow, disabled: boolean) {
    return (
      <select
        aria-label="請求月"
        value={billingMonthKey(resolveBillingMonth(item))}
        disabled={disabled}
        onChange={(e) => {
          const [year, month] = e.target.value.split('-').map(Number)
          setBillingMonths((prev) => ({ ...prev, [item.id]: { year, month } }))
        }}
        className="min-h-11 w-full rounded border bg-card px-2 py-1 text-sm disabled:bg-muted md:min-h-0"
      >
        {billingMonthOptions(item.item_date!).map((option) => (
          <option key={billingMonthKey(option)} value={billingMonthKey(option)}>
            {billingMonthLabel(option)}
          </option>
        ))}
      </select>
    )
  }

  // 確認ダイアログ用の一文。どの月の請求に乗るかは登録後に画面から直せないため、押す前に必ず見せる。
  // 全明細が同じ月なら1つの月として、分かれるときは月ごとの件数を並べる。
  function billingMonthSummary(row: ExpenseUploadRow): string {
    const targets = row.items.filter(isBillableItem)
    if (targets.length === 0) return ''
    const groups = new Map<string, { month: BillingMonth; count: number }>()
    for (const item of targets) {
      const month = resolveBillingMonth(item)
      const key = billingMonthKey(month)
      const found = groups.get(key)
      if (found) found.count += 1
      else groups.set(key, { month, count: 1 })
    }
    const entries = [...groups.values()].sort(
      (a, b) => a.month.year * 12 + a.month.month - (b.month.year * 12 + b.month.month)
    )
    if (entries.length === 1) return `${billingMonthLabel(entries[0].month)}として登録します。`
    return `請求月は${entries.map((e) => `${billingMonthLabel(e.month)}が${e.count}件`).join('、')}に分かれます。`
  }

  // 立替精算は代表へ返す実際の振込額になるため、請求額と同じく押す前に必ず見せる。
  function reimbursementSummary(row: ExpenseUploadRow): string {
    const targets = row.items.filter((item) => isReimbursableItem(item) && isReimburseChecked(item))
    if (targets.length === 0) return '立替精算に含める明細はありません。'
    const total = targets.reduce((sum, item) => sum + item.amount, 0)
    return `うち ${formatExpenseAmount(total)}（${targets.length}件）を代表への立替精算として、利用月の翌月の役員報酬に上乗せします。`
  }

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

  // ドライブ連携を使っていない運用では drive_file_id が常に null になる。
  // 設定の有無を知らないと、その全件を「保存失敗」として見せてしまうため、先に設定状況を確かめる。
  useEffect(() => {
    fetch('/api/google-drive/status', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<GoogleDriveStatus>) : null))
      .then((status) => setDriveConfigured(!!status?.configured))
      .catch(() => setDriveConfigured(false))
  }, [])

  // 409（登録済み・却下できない）や400（必須未入力の行）は、経理が次に何をすべきかを
  // サーバーの文言がそのまま説明している。言い換えず、そのまま画面に出す。
  // 読み取りのやり直し。Gemini の混雑など一時的な失敗はサーバー側でも自動で数回試すが、
  // それでも駄目だった分をここから人の判断で叩き直せるようにする。
  async function reExtract(row: ExpenseUploadRow) {
    setExtractingId(row.id)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/expense-uploads/${row.id}/extract`, { method: 'POST' })
      if (!res.ok) {
        setError(await readErrorMessage(res, '再読み取りに失敗しました。'))
        return
      }
      // 読み取り失敗は200＋error で返る（HTTPエラーだと理由が「通信に失敗しました」に丸められるため）。
      const outcome = (await res.json().catch(() => null)) as ExpenseExtractOutcome | null
      if (outcome && 'error' in outcome) {
        setError(`「${row.file_name}」の再読み取りに失敗しました。${outcome.error}`)
      } else {
        setNotice(
          `「${row.file_name}」を読み取り直しました。この受付は代表の割当待ち（割当中）に戻ります。` +
            '代表に受付URLから区分・クライアントの割り当てと送信をご依頼ください。' +
            '（この一覧には「登録済み・却下も表示する」で確認できます）'
        )
      }
      await load()
    } catch {
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    } finally {
      setExtractingId(null)
    }
  }

  async function review(row: ExpenseUploadRow, action: 'approve' | 'reject') {
    const id = row.id
    setBusyId(id)
    setError(null)
    setNotice(null)
    try {
      // 却下は何も登録しないので請求月は送らない（送っても意味が無く、APIの検証を通す理由も無い）。
      const init: RequestInit =
        action === 'approve'
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                items: row.items.filter(isBillableItem).map((item) => ({ id: item.id, ...resolveBillingMonth(item) })),
                reimburseItemIds: row.items.filter((item) => isReimbursableItem(item) && isReimburseChecked(item)).map((item) => item.id),
              }),
            }
          : { method: 'POST' }
      const res = await fetch(`/api/expense-uploads/${id}/${action}`, init)
      if (!res.ok) {
        setError(await readErrorMessage(res, action === 'approve' ? '登録に失敗しました。' : '却下に失敗しました。'))
        return
      }
      const result = (await res.json().catch(() => null)) as
        | ExpenseApproveResult
        | ExpenseRejectResult
        | null
      // 「登録は成立したが付随処理だけ失敗した」種類の警告は同時に起こりうる。
      // setError を個別に呼ぶと後から来た方だけが残って片方が消えるため、まとめて1つの枠に出す。
      const warnings: string[] = []
      // ドライブ保存の失敗は登録の失敗ではない。黙って進むと控えが残っていないことに誰も気づかないため、
      // 「登録は済んでいる」と分かる文言で理由を出す（操作自体は成功しているのでボタンは再試行側に出る）。
      if (result && 'drive' in result && 'error' in result.drive) {
        warnings.push(`登録は完了しましたが、原本をGoogleドライブへ保存できませんでした。${result.drive.error}（「保存を再試行」でやり直せます）`)
      }
      // 立替精算を作れなかったときは、経費の登録自体は成立している一方で「代表への返金だけが
      // 手当てされていない」状態になる。黙って進むと振込漏れになるため、理由と対処先を必ず出す。
      if (result && 'reimbursement' in result && 'skipped' in result.reimbursement) {
        warnings.push(`${result.reimbursement.skipped}マスタで役員を1名だけ有効にしたうえで、ダッシュボードの「立替明細」から手入力してください。`)
      }
      if (warnings.length > 0) setError(warnings.join('\n'))
      // 自動チェックは画面に出ない場所（ダッシュボード）が変わる操作なので、必ず知らせる。
      // ドライブ保存の失敗と同時に起きても、失敗はエラー枠・こちらは案内枠と別々に出るため文言は重ならない。
      // 立替精算はダッシュボード側に現れるため、ここで作ったことを伝えないと気づかれない。
      const notices: string[] = []
      if (result && 'reimbursement' in result && 'created' in result.reimbursement && result.reimbursement.created > 0) {
        notices.push(`立替精算の明細を${result.reimbursement.created}件作成しました（利用月の翌月の役員報酬に上乗せされます）。`)
      }
      if (result?.autoChecked) {
        notices.push('経費がすべて処理されたため、グローバルタスクの「社長経費確認」に自動でチェックを入れました。')
      }
      if (notices.length > 0) setNotice(notices.join('\n'))
      await load()
    } catch {
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    } finally {
      setBusyId(null)
    }
  }

  // ドライブ保存だけのやり直し。登録済みかつ未保存の受付に限り、サーバー側が同じ approve を
  // 「保存の再試行」として扱う（明細には触らないので、押しても二重請求にはならない）。
  async function retryDriveSave(row: ExpenseUploadRow) {
    setBusyId(row.id)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/expense-uploads/${row.id}/approve`, { method: 'POST' })
      if (!res.ok) {
        setError(await readErrorMessage(res, 'ドライブへの保存に失敗しました。'))
        return
      }
      const result = (await res.json().catch(() => null)) as ExpenseApproveResult | null
      if (result && 'error' in result.drive) {
        setError(`原本をGoogleドライブへ保存できませんでした。${result.drive.error}`)
      } else if (result && 'folderName' in result.drive) {
        setNotice(`「${row.file_name}」をGoogleドライブ（${result.drive.folderName}）に保存しました。`)
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
        <p className="text-xs leading-relaxed text-muted-foreground">
          代表から届いた経費ファイルの明細です。「クライアントに請求」の行だけが、登録すると
          そのクライアントへの請求経費になります。自社経費・対象外の行は記録だけが残ります。
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          「立替精算」にチェックが入った行は、代表へ返す実費として利用月の翌月の役員報酬に上乗せされます。
          会社カードで払った分など、返金の要らない行はチェックを外してください。
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
          登録済み・却下も表示する
        </label>
        <Button variant="outline" size="sm" className="h-11 md:h-7" onClick={() => load()}>
          再読み込み
        </Button>
      </div>

      {/* 警告は複数を改行でつないで渡すため、改行をそのまま行として見せる（案内枠も同じ）。 */}
      {error && (
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm whitespace-pre-line text-danger">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-info-subtle bg-info-subtle px-4 py-3 text-sm leading-relaxed whitespace-pre-line text-info">
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
          {showAll ? '受け付けた経費ファイルはまだありません。' : '確認待ちの経費ファイルはありません。'}
        </div>
      )}

      {rows?.map((row) => {
        const total = billedTotal(row.items)
        const billedCount = row.items.filter((item) => item.kind === 'client_billed').length
        const failed = isExtractFailed(row)
        const extracting = extractingId === row.id
        // 再読み取り中も却下を押せてしまうと、消える予定の明細に対して判断を下すことになるため一緒に止める。
        const busy = busyId === row.id || extracting
        // 請求月を選べるのは、これから経理が登録する受付（送信済み）に限る。
        // 登録済み・却下の受付で選択肢を出しても、押した結果が変わらず誤解を招くだけのため。
        const showBillingMonth = row.status === 'submitted' && row.items.some(isBillableItem)
        // 立替精算の選択も、これから登録する受付（送信済み）のときだけ意味を持つ。
        const showReimburse = row.status === 'submitted' && row.items.some(isReimbursableItem)
        return (
          <div key={row.id} className="rounded-lg border bg-card">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium break-all">{row.file_name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {row.submitted_at ? `${formatDateTime(row.submitted_at)} 送信` : `${formatDateTime(row.created_at)} 受付`}
                  {row.reviewed_at && `／${formatDateTime(row.reviewed_at)} 処理`}
                </p>
              </div>
              <StatusBadge status={failed ? EXTRACT_FAILED : row.status} />
            </div>

            {/* 失敗の理由はAIやネットワークが返した原文のまま出す。言い換えると
                「もう一度試せば直るのか」「ファイルを差し替えるべきか」の判断材料が失われるため。 */}
            {row.extract_error && (
              <p className="border-b px-4 py-2 text-xs break-words text-danger">{row.extract_error}</p>
            )}

            {/* 読み取りに失敗した受付は明細が1行も無い。表の枠だけが残ると壊れて見えるので、
                表・カードのどちらも出さずに、次にすべきことの説明を出す。 */}
            {row.items.length === 0 && (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                {failed ? (
                  <div className="space-y-1">
                    <p className="text-foreground">AIが原本を読み取れなかったため、明細がありません。</p>
                    <p className="text-xs leading-relaxed">
                      AI側の一時的な混雑が原因のことが多いので、まず「再読み取り」をお試しください。
                      成功するとこの受付は代表の割当待ちに戻り、代表が受付URLから割り当て・送信し直します。
                      経費以外の書類など、そもそも読み取れないファイルは「却下」で片付けてください。
                    </p>
                  </div>
                ) : (
                  <p>明細はありません。</p>
                )}
              </div>
            )}

            {/* 明細テーブル（PC・タブレット） */}
            <div className={cn('hidden overflow-x-auto', row.items.length > 0 && 'md:block')}>
              {/* 請求月の列が増えるぶんだけ最小幅も広げる。狭いままだと他の列が潰れて読めなくなる。 */}
              <table
                className={cn(
                  'w-full text-sm',
                  showBillingMonth ? 'min-w-[57rem]' : 'min-w-[48rem]',
                  showReimburse && 'min-w-[64rem]'
                )}
              >
                <thead className="border-b bg-secondary">
                  <tr>
                    <th className="w-[5rem] px-4 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">利用日</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">区間</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">内容</th>
                    <th className="w-[7rem] px-3 py-2 text-right font-medium whitespace-nowrap text-muted-foreground">金額</th>
                    <th className="w-[9rem] px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">区分</th>
                    <th className="w-[10rem] px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">クライアント</th>
                    {showBillingMonth && (
                      <th className="w-[9rem] px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">請求月</th>
                    )}
                    {showReimburse && (
                      <th className="w-[7rem] px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">立替精算</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {row.items.map((item) => (
                    <tr key={item.id} className="border-b align-top last:border-0">
                      <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">{formatExpenseDate(item.item_date)}</td>
                      <td className="px-3 py-2 text-foreground">{formatExpenseRoute(item.from_place, item.to_place) || '—'}</td>
                      <td className="px-3 py-2 text-foreground">{item.description ?? '—'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap text-foreground">
                        {formatExpenseAmount(item.amount)}
                      </td>
                      <td className="px-3 py-2">
                        <KindLabel kind={item.kind} />
                        {/* 登録済みの行が分かると、途中で失敗した受付をどこから追えばよいかが判断できる。 */}
                        {item.registered_client_expense_id && (
                          <span className="ml-1 text-xs whitespace-nowrap text-success">登録済み</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-foreground">{item.client_name ?? '—'}</td>
                      {/* 請求に乗らない行（自社経費・対象外）は請求月そのものが無いので空欄にする。
                          登録済みの行は月が確定しているため選び直させない。 */}
                      {showBillingMonth && (
                        <td className="px-3 py-2">
                          {isBillableItem(item) ? (
                            renderBillingMonthSelect(item, busy || !!item.registered_client_expense_id)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                      {/* 対象外の行は返金の対象にならないため、選択肢そのものを出さない。 */}
                      {showReimburse && (
                        <td className="px-3 py-2">
                          {isReimbursableItem(item) ? (
                            renderReimburseCheckbox(item, busy)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
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
                      <p className="text-xs break-words text-muted-foreground">
                        {formatExpenseRoute(item.from_place, item.to_place) || item.description || '—'}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-medium">{formatExpenseAmount(item.amount)}</p>
                  </div>
                  <div className="mt-2 space-y-1 rounded-lg bg-secondary px-3 py-2 text-xs">
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">区分</span>
                      <span className="text-right">
                        <KindLabel kind={item.kind} />
                        {item.registered_client_expense_id && <span className="ml-1 text-success">登録済み</span>}
                      </span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">クライアント</span>
                      <span className="text-right text-foreground">{item.client_name ?? '—'}</span>
                    </div>
                    {item.description && formatExpenseRoute(item.from_place, item.to_place) && (
                      <div className="flex justify-between gap-3">
                        <span className="shrink-0 text-muted-foreground">内容</span>
                        <span className="text-right text-foreground">{item.description}</span>
                      </div>
                    )}
                    {/* スマホでも同じ判断ができるよう、請求に乗る行にはプルダウンを出す。
                        幅が狭いので値と同じ列には並べず、ラベルの下に全幅で置く。 */}
                    {showBillingMonth && isBillableItem(item) && (
                      <div className="space-y-1 pt-1">
                        <span className="block text-muted-foreground">請求月</span>
                        {renderBillingMonthSelect(item, busy || !!item.registered_client_expense_id)}
                      </div>
                    )}
                    {showReimburse && isReimbursableItem(item) && (
                      <div className="pt-1">{renderReimburseCheckbox(item, busy)}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
              {/* 読み取り失敗の受付は必ず0円0件になる。判断材料にならない数字を出すと
                  「請求が0円で確定した」と読み違えられるため、失敗時は合計を出さない。 */}
              {failed ? (
                <div className="text-xs text-muted-foreground">明細を読み取れていません</div>
              ) : (
                <div className="text-sm">
                  <span className="text-muted-foreground">クライアントに請求</span>
                  <span className="ml-2 font-medium text-info">{formatExpenseAmount(total)}</span>
                  <span className="ml-1 text-xs text-muted-foreground">（{billedCount}件）</span>
                </div>
              )}
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
                {/* 読み取りに失敗した受付は、代表が先へ進めないまま止まっている。
                    経理がやり直すか片付けるかを決められるよう、この2つだけを出す。 */}
                {failed && (
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
                      onClick={() => reExtract(row)}
                      disabled={busy}
                    >
                      {extracting ? '読み取り中…' : '再読み取り'}
                    </Button>
                  </>
                )}
                {row.status === 'draft' && !failed && (
                  <span className="text-xs text-muted-foreground">代表が割当中です</span>
                )}
                {/* 登録済みの原本はドライブに控えが残る。保存できていない場合だけ、
                    控えが無い事実と直し方（再試行）をその場に出す。 */}
                {row.status === 'registered' && row.drive_link && (
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
                {driveConfigured && row.status === 'registered' && !row.drive_file_id && (
                  <>
                    <span className="text-xs text-muted-foreground">ドライブ未保存</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11 md:h-7"
                      onClick={() => retryDriveSave(row)}
                      disabled={busy}
                    >
                      {busyId === row.id ? '保存中…' : '保存を再試行'}
                    </Button>
                  </>
                )}
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
                ? `「${confirmTarget.row.file_name}」のうち「クライアントに請求」の明細 ${formatExpenseAmount(billedTotal(confirmTarget.row.items))} を請求経費として登録します。${billingMonthSummary(confirmTarget.row)}${reimbursementSummary(confirmTarget.row)}登録後は取り消せません。`
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
                if (target) review(target.row, target.action)
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
