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
import {
  CAUTION_LABEL_SEPARATOR,
  cautionKeyFromNoteText,
  extractItemDate,
  matchedNameLength,
  normalizeName,
  toExpenseDate,
} from '@/lib/invoice-match'
import type {
  InvoiceCheckRow,
  InvoiceDeliverySheetLink,
  InvoiceExpenseAssignment,
  InvoiceExtractedItem,
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
// caution（注意）はNG・保留と違い判定そのものではなく「自動確認できないので人が見て」という
// 案内。印としては保留と同系の警告色で見せてよいが、[注意]という別の印として保存・パースされる
// ため、判定理由に「注意」という別種の行があることは区別できる。
const NOTE_CLASS: Record<InvoiceNoteMark, string> = {
  ng: 'rounded bg-danger-subtle px-2 py-1 font-medium text-danger',
  hold: 'rounded bg-warning-subtle px-2 py-1 text-warning',
  caution: 'rounded bg-warning-subtle px-2 py-1 text-warning',
  saveFailed: 'rounded bg-warning-subtle px-2 py-1 text-warning',
  received: 'text-gray-500',
  fixed: 'text-gray-500',
  saved: 'text-gray-500',
  ok: 'text-gray-500',
}

// 注意（[注意]）は「自動では判断できないので人が見てください」という案内。人が見終わったら
// 消し込めるようにする。確認済みの印はサーバー側（invoice_uploads.confirmed_cautions）に貯め、
// 注意1件を指すキーは注意行の本文から復元する（lib/invoice-match の cautionKeyFromNoteText）。
// 判定理由に「|key=…」のような機械用の文字列を埋め込む方式は、そのまま人の目に触れるうえ
// 文言を1文字変えるとキーが壊れるため採らない。本文の先頭が必ず明細ラベルの原文になっている
// という約束だけを守れば、サーバーと画面が同じキーを作れる。
function NoteLine({ line, onConfirmCaution, busy }: {
  line: InvoiceNoteLine
  onConfirmCaution: (key: string, confirmed: boolean) => void
  busy: boolean
}) {
  // キーを復元できない行（この仕組みより前に保存された注意など）は操作の対象外。
  const key = cautionKeyFromNoteText(line.text)
  // 確認済みにした注意は [OK] の「…確認済み」行として残る（消してしまうと、確認した結果なのか
  // 注意自体が出なくなったのかが区別できない）。誤操作の戻し用に取り消しも出す。
  const confirmed = line.mark === 'ok' && line.text.includes('確認済み')
  const action: { kind: 'confirm' | 'revert'; key: string } | null =
    key === null
      ? null
      : line.mark === 'caution'
        ? { kind: 'confirm', key }
        : confirmed
          ? { kind: 'revert', key }
          : null

  // 印が読めない行は印を付ける前に保存された過去データ。内容が判断できないので中立表示にする。
  return (
    <div className={cn('flex items-start justify-between gap-2', line.mark === 'caution' && 'rounded bg-warning-subtle pr-1')}>
      <p
        className={cn(
          'text-xs leading-relaxed',
          line.mark ? NOTE_CLASS[line.mark] : 'text-gray-600',
          // 背景は外側の箱に移したので、注意行の内側では重ねない。
          line.mark === 'caution' && 'bg-transparent'
        )}
      >
        {line.text}
      </p>
      {action?.kind === 'confirm' && (
        <button
          type="button"
          onClick={() => onConfirmCaution(action.key, true)}
          disabled={busy}
          // スマホでのタップ領域を44px確保する（PCは従来の行高のまま）。
          className="flex min-h-11 shrink-0 items-center rounded border border-warning/40 px-2 text-xs font-medium whitespace-nowrap text-warning hover:bg-warning-subtle disabled:opacity-40 md:min-h-7"
        >
          確認済みにする
        </button>
      )}
      {action?.kind === 'revert' && (
        <button
          type="button"
          onClick={() => onConfirmCaution(action.key, false)}
          disabled={busy}
          className="flex min-h-11 shrink-0 items-center px-1 text-xs whitespace-nowrap text-gray-400 hover:underline disabled:opacity-40 md:min-h-0"
        >
          取り消す
        </button>
      )}
    </div>
  )
}

// 注意1件をコンパクト表示に要約する。本文が「<明細ラベル原文> — <説明>」の形（cautionKeyFromNoteText
// が読める形）でない古い形式は null を返し、呼び出し側で従来どおりの単独箱にフォールバックさせる。
// 表示名はラベル原文の「様」までに切り詰め、種別（記載日／支払回数）と N/M は既存のキー抽出
// （lib/invoice-match の cautionKeyOf 由来）を再利用して取り出す。新しく正規表現を作り直さない。
function summarizeCaution(text: string): { key: string; display: string } | null {
  const key = cautionKeyFromNoteText(text)
  if (key === null) return null
  const sepIndex = text.lastIndexOf(CAUTION_LABEL_SEPARATOR)
  const label = text.slice(0, sepIndex)
  const body = text.slice(sepIndex + CAUTION_LABEL_SEPARATOR.length)
  const nameEnd = label.indexOf('様')
  const displayName = nameEnd >= 0 ? label.slice(0, nameEnd + 1) : label
  const typeLabel = body.includes('記載日') ? '記載日' : body.includes('支払回数') ? '支払回数' : null
  // cautionKeyOf は "<正規化ラベル>|<N/M>" の形を作るので、キーの後半をそのままN/Mとして使い回す。
  const nm = key.split('|')[1] || null
  const display = typeLabel && nm ? `${displayName}（${typeLabel} ${nm}）` : displayName
  return { key, display }
}

// 注意（[注意]）が複数件あると縦に長文の箱が並んで冗長になるため、1つの警告枠にまとめて
// 1件1行のコンパクト表示にする。キーが読めない古い形式の行だけは従来どおり個別の箱に残す
// （このコンポーネントの外＝CheckNotes 側で振り分ける）。
function CautionGroup({ items, onConfirmCaution, busy }: {
  items: { line: InvoiceNoteLine; key: string; display: string }[]
  onConfirmCaution: (key: string, confirmed: boolean) => void
  busy: boolean
}) {
  if (items.length === 0) return null
  return (
    <div className="rounded bg-warning-subtle px-2 py-1.5">
      <p className="mb-1 text-[10px] font-semibold tracking-wide text-warning">要確認</p>
      <div className="space-y-1">
        {items.map(({ line, key, display }, i) => (
          <div key={i} title={line.text} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="min-w-0 flex-1 text-xs break-words text-warning">{display}</span>
            <button
              type="button"
              onClick={() => onConfirmCaution(key, true)}
              disabled={busy}
              // スマホでのタップ領域を44px確保する（PCは従来の行高のまま）。
              className="flex min-h-11 shrink-0 items-center rounded border border-warning/40 px-2 text-xs font-medium whitespace-nowrap text-warning hover:bg-warning-subtle disabled:opacity-40 md:min-h-7"
            >
              確認済み
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// 判定理由は観点ごとに1行。全行を並べるとOK行がノイズになりNGが埋もれるため、
// 既定ではNG・保留（と受領・修正の記録、印なしの過去データ）だけを出し、OK行は開いたときだけ見せる。
// 注意（caution）行だけは複数件並ぶと冗長なので、他の行とは別にまとめて1つの枠に集約する。
function CheckNotes({ notes, onConfirmCaution, busy }: {
  notes: string | null
  onConfirmCaution: (key: string, confirmed: boolean) => void
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const lines = useMemo(() => parseInvoiceNotes(notes), [notes])
  if (lines.length === 0) return null

  const primary = lines.filter((line) => line.mark !== 'ok')
  const details = lines.filter((line) => line.mark === 'ok')

  const otherPrimary = primary.filter((line) => line.mark !== 'caution')
  const cautionLines = primary.filter((line) => line.mark === 'caution')
  // キーが読める行だけを集約枠へ。読めない古い形式はNoteLineでの従来表示（単独箱・ボタンなし）に残す。
  const keyedCautions: { line: InvoiceNoteLine; key: string; display: string }[] = []
  const legacyCautions: InvoiceNoteLine[] = []
  for (const line of cautionLines) {
    const summary = summarizeCaution(line.text)
    if (summary) keyedCautions.push({ line, ...summary })
    else legacyCautions.push(line)
  }

  return (
    <div className="space-y-1">
      {otherPrimary.map((line, i) => (
        <NoteLine key={`other-${i}`} line={line} onConfirmCaution={onConfirmCaution} busy={busy} />
      ))}
      <CautionGroup items={keyedCautions} onConfirmCaution={onConfirmCaution} busy={busy} />
      {legacyCautions.map((line, i) => (
        <NoteLine key={`legacy-${i}`} line={line} onConfirmCaution={onConfirmCaution} busy={busy} />
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
                <NoteLine key={i} line={line} onConfirmCaution={onConfirmCaution} busy={busy} />
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
            編集者・代行者とも「◯月分」はその月の業務分を指し、支払いは翌月です。照合する支払予定額と
            「請求書受領」チェックは翌月の行に付きます。
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
            明細に「19/24」のような支払回数が書かれているときは、マスタの支払期間（開始月と回数）から
            契約の終了月を割り出して照合します。合わない場合は判定を変えずに注意として出ます。
          </li>
          <li>
            「7/28」を台本作成日として書くクライアントは、マスタ管理のクライアント編集で
            「明細の数字（N/M）を日付として扱う」にチェックを入れてください。回数としての照合を行わず、
            記載日の作業実施を確認する注意だけを出します。
          </li>
          <li>
            「◯◯の作業実施をご確認ください」のような注意は、内容を確かめたら「確認済みにする」で消し込めます。
            確認済みにした注意は「詳細を見る」の中に残り、押し間違えたときは「取り消す」で戻せます。
            再チェックや再読み取りを行っても確認済みの状態は保持されます。
          </li>
          <li>
            明細が通称や略称（「めぐ姉様」など）で書かれていて特定できないときは、マスタ管理のクライアント編集で
            「別名」にカンマ区切りで登録すると、次回の照合から正式名と同じものとして扱われます。
          </li>
          <li>
            交通費などの経費の明細は、クライアント別ではなく対象月に登録済みの立替経費の合計と照合します。
            経費が未登録でNGになった行には「経費を登録」ボタンが出るので、請求書の明細をそのまま
            立替経費として登録できます（登録後は自動で再チェックまで行います）。
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

// ─── 経費のその場登録 ───────────────────────────────────────────
// 請求書に経費の明細があるのに立替経費が未登録・金額違いだと必ずNGになる。従来はダッシュボードへ
// 移動して1件ずつ入力し直す必要があったため、請求書の明細をそのまま初期値にした登録口をここに置く。

function expenseItemsOf(r: InvoiceCheckRow): InvoiceExtractedItem[] {
  return (r.extracted_items ?? []).filter((item) => item.kind === 'expense')
}

// 経費が原因のNGかどうか。判定理由（lib/invoice-check の compareExpenses）が出す経費関連のNGは
// いずれも文言に「経費」を含むため、印がNGの行にその語があるかで見分ける。
function hasExpenseNg(notes: string | null): boolean {
  return parseInvoiceNotes(notes).some((line) => line.mark === 'ng' && line.text.includes('経費'))
}

// 登録口を出す条件。経費のNGが出ていても、初期値にする明細・登録先アサイン・登録先の月が
// 揃っていなければフォームを埋められないため、そろっている行だけに出す。
function canRegisterExpense(r: InvoiceCheckRow): boolean {
  return (
    hasExpenseNg(r.check_notes) &&
    expenseItemsOf(r).length > 0 &&
    r.expense_assignments.length > 0 &&
    r.payout_year !== null &&
    r.payout_month !== null
  )
}

// 明細ラベルから登録先アサインを推定する。照合本体と同じ「ラベルの中に呼び名があるか」で見て、
// 最長一致が1つに絞れたときだけ採用する（複数当たる場合は人に選ばせる）。
// 候補が1つしかない委託者は迷いようがないのでそれを選ぶ。
function guessAssignmentId(label: string, candidates: InvoiceExpenseAssignment[]): string {
  if (candidates.length === 1) return candidates[0].id
  const norm = normalizeName(label)
  if (norm.length === 0) return ''
  const hits = candidates
    .map((a) => ({ a, length: matchedNameLength(norm, a.matchNames) }))
    .filter(({ length }) => length > 0)
  if (hits.length === 0) return ''
  const longest = Math.max(...hits.map((h) => h.length))
  const best = hits.filter((h) => h.length === longest)
  return best.length === 1 ? best[0].a.id : ''
}

// 明細ラベルの「7/16」を経費の日付に直す。基準は請求書の対象月（記載月）で、
// 読めなければ空欄にする（推測で日付を入れると、あとから実費と突き合わせられなくなる）。
function guessExpenseDate(label: string, r: InvoiceCheckRow): string {
  const baseYear = r.resolved_year ?? r.extracted_year
  const baseMonth = r.resolved_month ?? r.extracted_month
  if (baseYear === null || baseMonth === null) return ''
  const date = extractItemDate(label)
  return date ? toExpenseDate(date.month, date.day, baseYear, baseMonth) : ''
}

interface ExpenseDraft {
  amount: string
  date: string
  note: string
  assignmentId: string
  // 途中で失敗したときの再送で同じ経費を二重登録しないための控え。
  done: boolean
}

function ExpenseRegisterDialog({ target, onClose, onRegistered, onError }: {
  target: InvoiceCheckRow | null
  onClose: () => void
  onRegistered: (id: string) => void
  onError: (msg: string) => void
}) {
  const [drafts, setDrafts] = useState<ExpenseDraft[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!target) return
    setDrafts(
      expenseItemsOf(target).map((item) => ({
        amount: item.amount === null ? '' : String(item.amount),
        date: guessExpenseDate(item.label, target),
        note: item.label,
        assignmentId: guessAssignmentId(item.label, target.expense_assignments),
        done: false,
      }))
    )
  }, [target])

  function update(index: number, patch: Partial<ExpenseDraft>) {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!target || target.payout_year === null || target.payout_month === null) return
    const pending = drafts.map((d, i) => ({ d, i })).filter(({ d }) => !d.done)
    if (pending.length === 0) {
      onRegistered(target.id)
      return
    }
    if (pending.some(({ d }) => d.assignmentId === '')) {
      onError('登録先アサインを選んでください。')
      return
    }
    if (pending.some(({ d }) => d.amount.trim() === '' || !(Number(d.amount) > 0))) {
      onError('金額を入力してください。')
      return
    }

    setSaving(true)
    try {
      // 経費APIは1件ずつの登録なので順に送る。途中で失敗しても、成功した行は done を立てて
      // 再送の対象から外す（まとめて送り直すと同じ経費が二重に入る）。
      for (const { d, i } of pending) {
        const res = await fetch('/api/expenses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assignment_id: d.assignmentId,
            // 経費は支払月の行に紐づく（照合もその月の合計と突き合わせる）。
            year: target.payout_year,
            month: target.payout_month,
            expense_date: d.date || null,
            amount: Number(d.amount),
            note: d.note.trim() || null,
          }),
        })
        if (!res.ok) {
          setSaving(false)
          onError(await readErrorMessage(res, '経費の登録に失敗しました。'))
          return
        }
        update(i, { done: true })
      }
      setSaving(false)
      onRegistered(target.id)
    } catch {
      setSaving(false)
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  return (
    <FormDialog open={!!target} onClose={onClose} title="経費を登録" maxWidth="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs leading-relaxed text-gray-500">
          「{target?.file_name}」の経費明細をそのまま立替経費として登録します。登録先は
          {target && target.payout_year !== null && target.payout_month !== null
            ? `${target.payout_year}年${target.payout_month}月（支払月）`
            : '支払月'}
          です。登録後は自動で再チェックを行います。
        </p>

        <div className="space-y-3">
          {drafts.map((d, index) => (
            <div key={index} className="space-y-2 rounded-lg border bg-gray-50/50 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">
                    金額 <span className="text-danger">*</span>
                  </label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={d.amount}
                    disabled={d.done}
                    onChange={(e) => update(index, { amount: e.target.value })}
                    className="min-h-11 w-full rounded border px-3 py-2 text-sm disabled:bg-gray-100 md:min-h-0"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">日付</label>
                  <input
                    type="date"
                    value={d.date}
                    disabled={d.done}
                    onChange={(e) => update(index, { date: e.target.value })}
                    className="min-h-11 w-full rounded border px-3 py-2 text-sm disabled:bg-gray-100 md:min-h-0"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">メモ</label>
                <input
                  value={d.note}
                  disabled={d.done}
                  onChange={(e) => update(index, { note: e.target.value })}
                  className="min-h-11 w-full rounded border px-3 py-2 text-sm disabled:bg-gray-100 md:min-h-0"
                  placeholder="明細の内容"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">
                  登録先アサイン <span className="text-danger">*</span>
                </label>
                <select
                  value={d.assignmentId}
                  disabled={d.done}
                  onChange={(e) => update(index, { assignmentId: e.target.value })}
                  className="min-h-11 w-full rounded border bg-white px-3 py-2 text-sm disabled:bg-gray-100 md:min-h-0"
                >
                  <option value="">選択してください</option>
                  {(target?.expense_assignments ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.clientName}
                    </option>
                  ))}
                </select>
              </div>
              {d.done && <p className="text-xs text-success">登録しました</p>}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" className="h-11 md:h-7" type="button" onClick={onClose}>
            キャンセル
          </Button>
          <Button size="sm" className="h-11 md:h-7" type="submit" disabled={saving || drafts.length === 0}>
            {saving ? '登録中…' : '登録して再チェック'}
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
  const [expenseTarget, setExpenseTarget] = useState<InvoiceCheckRow | null>(null)
  const [cautionBusyId, setCautionBusyId] = useState<string | null>(null)

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

  // 注意の消し込み（confirmed=false で取り消し）。サーバー側で確認済みキーを保存したあと
  // 照合をやり直すため、戻ってきたら一覧を取り直して判定理由を差し替える。
  async function confirmCaution(id: string, key: string, confirmed: boolean) {
    setCautionBusyId(id)
    setError(null)
    try {
      const res = await fetch(`/api/invoice-check/${id}/confirm-caution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, confirmed }),
      })
      if (!res.ok) {
        setError(await readErrorMessage(res, '注意の確認状態を更新できませんでした。'))
        return
      }
      // 読み取り失敗行では照合そのものが行われない。理由が返ってきたら画面に出す。
      const data = (await res.json().catch(() => null)) as { skipped?: string } | null
      if (typeof data?.skipped === 'string') setError(data.skipped)
      await load()
    } catch {
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    } finally {
      setCautionBusyId(null)
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

  // 経費を登録しただけでは判定は変わらない（保存済みの check_notes を見ているため）。
  // 登録の目的は「経費のNGを消すこと」なので、続けて再チェックまで自動で走らせる。
  async function handleExpensesRegistered(id: string) {
    setExpenseTarget(null)
    await recheck(id)
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
                      <div className="mt-1">
                        <CheckNotes
                          notes={r.check_notes}
                          onConfirmCaution={(key, confirmed) => confirmCaution(r.id, key, confirmed)}
                          busy={cautionBusyId === r.id || busy(r.id)}
                        />
                      </div>
                      {r.delivery_sheets.length > 0 && (
                        <div className="mt-1"><DeliverySheetLinks sheets={r.delivery_sheets} /></div>
                      )}
                      {/* 経費NGの対応はこの場で終わらせられるので、判定のすぐ下（右寄せ）に登録口を出す。 */}
                      {canRegisterExpense(r) && (
                        <div className="mt-2 flex justify-end">
                          <Button size="sm" className="h-11 md:h-7" onClick={() => setExpenseTarget(r)}>
                            経費を登録
                          </Button>
                        </div>
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

                {r.check_notes && (
                  <div className="mt-2">
                    <CheckNotes
                      notes={r.check_notes}
                      onConfirmCaution={(key, confirmed) => confirmCaution(r.id, key, confirmed)}
                      busy={cautionBusyId === r.id || busy(r.id)}
                    />
                  </div>
                )}
                {r.extract_error && <div className="mt-2 text-xs text-danger">{r.extract_error}</div>}
                {r.delivery_sheets.length > 0 && (
                  <div className="mt-2"><DeliverySheetLinks sheets={r.delivery_sheets} /></div>
                )}

                {/* 経費NGはこの場で直せるため、他の操作より前に出す（塗りボタンで目立たせる）。 */}
                {canRegisterExpense(r) && (
                  <div className="mt-2">
                    <Button size="sm" className="h-11 w-full" onClick={() => setExpenseTarget(r)}>
                      経費を登録
                    </Button>
                  </div>
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

      <ExpenseRegisterDialog
        target={expenseTarget}
        onClose={() => setExpenseTarget(null)}
        onRegistered={handleExpensesRegistered}
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
