import 'server-only'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  assignments,
  clients,
  contractors,
  expenses,
  invoiceCheckHistory,
  invoiceReplies,
  invoiceUploads,
  monthlyRecords,
} from '@/lib/schema'
import { checkAssignmentDelivery } from '@/lib/sheets'
import { deliveryTargetMonth, deliveryTone, suggestedPayout } from '@/lib/delivery-status'
import {
  COMPANY_NAME,
  INVOICE_REPLY_NG_TEMPLATE,
  INVOICE_REPLY_OK_EXTRAS_TEMPLATE,
  INVOICE_REPLY_OK_TEMPLATE,
  INVOICE_REPLY_REASON_TEMPLATES,
  INVOICE_REPLY_UNKNOWN_MONTH,
} from '@/lib/config'
import { nowJST } from '@/lib/dates'
import { isPaymentActiveForMonth } from '@/lib/monthly-records'
import { uploadFileToDrive, sanitizeFileNamePart } from '@/lib/google-drive'
import {
  INVOICE_MANUAL_EDIT_NOTE,
  INVOICE_NOTE_MARKS,
  formatAssignLink,
  formatInvoiceNote,
  hasInvoiceNoteMark,
  parseInvoiceNotes,
} from '@/lib/invoice-notes'
import { compareTotalWithExtras, decideExtraItems, extraItemTitle } from '@/lib/invoice-extra'
import { buildInvoiceReplyBody } from '@/lib/invoice-reply'
import { getOrCreateInvoiceUploadToken } from '@/lib/invoice-token'
import {
  attributeWorkItems,
  clientMatchNames,
  effectiveItemKind,
  isRevisionLabel,
  normalizeName,
  parseClientAliases,
} from '@/lib/invoice-match'
import {
  addMonths,
  compareInvoiceItems,
  compareInvoiceTotal,
  formatYearMonth,
  judgeEditorInvoiceByCap,
  parseYearMonth,
  yen,
} from '@/lib/invoice-judge'
import type {
  DeliveryCheckRow,
  DriveUploadOutcome,
  EditorCapRecord,
  InvoiceCheckOutcome,
  InvoiceCheckResult,
  InvoiceCheckStatus,
  InvoiceCheckTrigger,
  InvoiceDeliveryPayoutApply,
  InvoiceExtraItem,
  InvoiceManualApprovePreview,
  InvoiceNgReason,
  InvoiceOutOfPeriodClient,
  InvoicePaymentCountNote,
  InvoicePayoutBreakdownRow,
  InvoiceReplyKind,
  InvoiceSkippedClient,
  InvoiceUnassignedClient,
  InvoiceUnassignedNote,
  InvoiceVerdict,
  InvoiceYearMonth,
} from '@/lib/ui-types'

// 3観点（差出人・対象月＋金額・宛名）それぞれの結論（ok=一致 / ng=不一致 / hold=判定材料不足）。
// 判定の中身（明細・合計・経費の突き合わせ）は DB を読まない lib/invoice-judge に切り出してあり、
// このファイルはデータを集めて渡し、結果を判定理由に積む層になっている。
type Verdict = InvoiceVerdict
type YearMonth = InvoiceYearMonth

// 名前の正規化・呼び名の展開・ラベルとの一致判定は lib/invoice-match に集約している
// （経費のその場登録ダイアログでも同じ基準で明細をクライアントへ割り当てるため）。

// 年の記載が無い請求書（「7月分」だけ）の年を補う。
// 未来月の請求は届かない前提で「今日以前で最も近いその月」を採る（8月時点の「9月分」は前年9月）。
function resolveYear(month: number, extractedYear: number | null): number {
  if (extractedYear !== null) return extractedYear
  const today = nowJST()
  return month <= today.getMonth() + 1 ? today.getFullYear() : today.getFullYear() - 1
}

// 請求書の「M月分」が指す支払月を求める。契約者は編集者・代行者とも「M月分＝その月の業務、
// 支払いは翌月」という運用のため、種別を問わずM月に対する支払月はM+1月になる。
// 月次レコード・立替経費・受領チェック・ドライブの保存先フォルダはいずれも「支払月」の行・場所に
// 紐づくので、参照先はこの月に揃える。
// 一方 resolved_year / resolved_month（画面の対象月表示）は請求書の記載どおり M のままにする
// （人が請求書を見て探す手がかりは記載月のため）。
// 12月分→翌年1月支払いの繰り上がりは Date に任せる（自前の +1 では年をまたげない）。
// 一覧API（経費のその場登録で「どの月に登録するか」を決めるとき）からも使うため export する。
export function payoutMonthOf(year: number, month: number): { year: number; month: number } {
  const d = new Date(year, month, 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}

// 納品シートから支払額を割り出せなかった理由。「確定できません」だけでは何を直せばよいか分からないため、
// シート側の具体的な状況（URL未登録・権限不足・本数不足など）をそのまま伝える。
// 納品予定0件（tone === 'none'）は呼び出し側で0円として処理するため、ここには来ない。
function deliveryHoldDetail(row: DeliveryCheckRow, unitPrice: number): string {
  if (row.status !== 'ok' && row.message) return row.message
  const tone = deliveryTone(row)
  if (tone === 'short') return `納品が揃っていません（${row.delivered ?? 0}/${row.expected ?? 0}本）`
  if (unitPrice <= 0) return '編集者の単価が未設定です'
  return '納品チェックの結果を取得できませんでした'
}

type ContractorRow = {
  id: string
  name: string
  contractor_type: 'daiko' | 'video_editor'
  unit_price: number
  chatwork_account_id: string | null
}

// 照合OKになったときだけ月次レコードへ書き戻す納品実績。請求書チェックの中で納品シートを
// 読んで金額を出せた編集者の行だけが入る（既に実支払額が入っている行・代行者は対象外）。
type DeliveryPayoutApply = InvoiceDeliveryPayoutApply

// notes は算出の途中で人に伝えたい補足（納品予定0件の月など）。金額だけでは
// 「なぜその予定額になったのか」が追えないため、判定理由に混ぜて残す。
// breakdown は合計の内訳（アサイン単位）。合計が合っていても「Aで1本多くBで1本少ない」ように
// 相殺していることがあるため、請求書の明細と突き合わせる相手として合計と一緒に持ち回る。
// expenseTotal（登録済みの立替経費の合計）は breakdown に混ぜず別に持つ。経費の請求は
// クライアント別ではなく「実費の合計」で書かれるため、突き合わせる相手が違うため。
// skipped は今月の支払いをスキップ中のクライアント。breakdown（金額・内訳・合計）には入れず、
// 請求書にそのクライアント分の明細が載ってきたときに専用の文言で保留にするためだけに持つ。
type SkippedClient = InvoiceSkippedClient

// outOfPeriod は有効なアサインだが、支払期間（支払開始月・支払回数）が今月の支払いを含まないクライアント。
// 期間外の月には月次レコードが作られず breakdown に出ないため、請求書に明細が載ってきても
// 「マスタに見つかりません」と誤って案内しないよう、期間外であることを伝える文言（detail）を控えておく。
type OutOfPeriodClient = InvoiceOutOfPeriodClient

// unassigned は取引先マスタにはあるが、この委託者の有効なアサインに入っていないクライアント。
// 請求書に明細が載ってきたとき、「マスタに見つかりません」（＝別名の登録漏れ）と誤解させず、
// 担当（アサイン）を足せば直ることを伝えるために、照合用の名前と一緒に控えておく。
type UnassignedClient = InvoiceUnassignedClient

type ExpectedOutcome =
  | {
      amount: number
      notes: string[]
      breakdown: InvoicePayoutBreakdownRow[]
      skipped: SkippedClient[]
      outOfPeriod: OutOfPeriodClient[]
      unassigned: UnassignedClient[]
      expenseTotal: number
      // 認め済みの追加費用が指す明細のキー（lib/invoice-extra）。金額は amount に足し込み済みで、
      // ここでは「請求書のどの明細が認め済みか」を引くためだけに持つ。
      approvedExtraKeys: Set<string>
      payouts: DeliveryPayoutApply[]
      // 納品シートから金額を出せなかった行（tolerateDeliveryHold のときだけ入る）。内訳には ¥0 で
      // 載せてあるので、「予定0円」と取り違えないよう呼び出し側がここで見分ける。
      unresolvedRecordIds: string[]
      // 納品シートで修正の行として通常の本数から外した件数（クライアント別。0件のクライアントは入らない）。
      // 請求書に修正費の記載があるかを確かめる手がかりにする。
      sheetRevisions: { clientName: string; count: number }[]
      // 認め済みの追加費用（経費の表に登録済みの分）の合計。amount には足し込み済み。
      // 請求書を正にする方式（lib/invoice-judge）では支払予定額を組み直すため、別にも持つ。
      approvedExtraTotal: number
      // 編集者の記録行ごとの材料（確定済みの額・納品シートを読んだ結果）。代行者は空。
      // 請求書を正にする方式は、上の breakdown（納品実績＝支払予定）ではなくこちらを使って判定する。
      editorRecords: EditorCapRecord[]
    }
  // holdDetails は保留の理由が複数あるときの内訳（1件1行）。hold はその見出しになる。
  | { hold: string; holdDetails?: string[] }

// スキップ中のクライアントの補足。従来の算出（notes）と請求書を正にする方式とで同じ文言を出すため1か所に置く。
function skippedPayoutNote(clientName: string): string {
  return `${clientName}: 今月の支払いはスキップ（¥0）`
}

// 支払月に「その委託者へいくら払う予定か」を算出する。year / month は請求書の記載月ではなく
// 支払月（記載月の翌月。payoutMonthOf 参照）。月次レコードも立替経費も支払月で並んでいるため。
// 代行者は契約額（当月の控えを優先）、編集者は納品チェックで反映済みの実支払額を正とし、
// 未反映なら納品シートをその場で読んで補う。立替経費は同額を支払いに乗せるため合算する。
// ダッシュボードの支払予定額（recordPayout）と同じ定義に揃えてある（食い違うと照合が信用できなくなる）。
async function computeExpectedPayout(
  contractor: ContractorRow,
  year: number,
  month: number,
  // 支払月が請求書の記載月とずれるときだけ、保留文言に「（支払月）」と添える
  // （現状は編集者・代行者とも常にずれるため常に true になるが、将来の例外に備えて残す）。
  payoutMonthShifted: boolean,
  // 手動OKの割り当て案は、納品シートを読めない行があっても他の行の内訳と明細の帰属先を知りたい。
  // true のときは納品チェック未反映で全体を保留にせず、その行を金額不明として先へ進む。
  // 編集者の請求書を正にする方式（lib/invoice-judge）も、読めない行を「載っていれば保留・載っていなければ無視」と
  // 行ごとに扱うため true で呼び、editorRecords を材料に使う。
  options: { tolerateDeliveryHold?: boolean } = {}
): Promise<ExpectedOutcome> {
  const assignmentRows = await db.query.assignments.findMany({
    where: (a, { and: andOp, eq: eqOp }) => andOp(eqOp(a.contractor_id, contractor.id), eqOp(a.active, true)),
    // aliases は明細ラベルとの照合に使う（正式名だけでは通称・略称で書かれた明細を拾えない）。
    // nm_as_date は明細の「N/M」を支払回数と読むか日付と読むかの切り替え（クライアント単位の運用差）。
    with: { clients: { columns: { name: true, aliases: true, nm_as_date: true } } },
  })
  if (assignmentRows.length === 0) {
    return { hold: `委託者「${contractor.name}」に有効なアサインがありません` }
  }

  const assignmentIds = assignmentRows.map((a) => a.id)
  const records = await db
    .select()
    .from(monthlyRecords)
    .where(
      and(
        inArray(monthlyRecords.assignment_id, assignmentIds),
        eq(monthlyRecords.year, year),
        eq(monthlyRecords.month, month)
      )
    )
  if (records.length === 0) {
    return { hold: `${year}年${month}月分${payoutMonthShifted ? '（支払月）' : ''}の月次レコードがありません` }
  }

  const isVideoEditor = contractor.contractor_type === 'video_editor'
  // 編集者の支払いは前月の納品に対して行うため、支払月から見た納品シートの月は1つ手前になる
  // （編集者の「M月分」は支払月 M+1 で渡ってくるので、ここで読むのは記載どおりの M 月タブ）。
  // 年も使うのは、納品シートに前年同月のタブ・行が残っていても取り違えないため（1月支払いの12月納品は前年になる）。
  const deliveryTarget = deliveryTargetMonth(year, month)
  let total = 0
  const notes: string[] = []
  const breakdown: InvoicePayoutBreakdownRow[] = []
  const skipped: SkippedClient[] = []
  const payouts: DeliveryPayoutApply[] = []
  const unresolvedRecordIds: string[] = []
  const deliveryHolds: string[] = []
  const sheetRevisions: { clientName: string; count: number }[] = []
  const editorRecords: EditorCapRecord[] = []

  for (const record of records) {
    const assignment = assignmentRows.find((a) => a.id === record.assignment_id)
    if (!assignment) continue
    const client = assignment.clients
    const clientName = client?.name ?? '?'
    // スキップした月は払わないと決めた行。金額にも内訳にも入れないことで、請求書に載っていなくても
    // 「見当たりません」にならない。逆に請求書へ載ってきた場合は内訳に相手がいないので保留になり、人が見る
    // （skipped に照合名だけ控えておき、明細が当たったらスキップ中だと伝える）。
    // 納品シートも読まない（払わない行のために保留になったり、支払額を書き戻したりしないため）。
    if (record.skipped_at) {
      notes.push(skippedPayoutNote(clientName))
      if (client) skipped.push({ clientName, matchNames: clientMatchNames(client.name, client.aliases) })
      continue
    }
    // クライアントが引けない行は照合の当たり先にならないよう候補名を空にする
    // （'?' を候補にすると、記号を含む明細に誤って吸い付いてしまう）。
    const matchNames = client ? clientMatchNames(client.name, client.aliases) : []
    // 明細の「19/24」（支払回数）の検証に使う支払期間。どの行でも同じ値を渡すのでまとめて作る。
    // nmAsDate はそのクライアントの「N/M」の読み方。クライアントが引けない行は
    // 回数として読む従来どおりの扱い（false）にする。
    const payment = {
      paymentStartMonth: assignment.payment_start_month,
      paymentCount: assignment.payment_count,
      nmAsDate: client?.nm_as_date ?? false,
    }

    if (!isVideoEditor) {
      // 代行者は契約額での支払い＝本数の概念が無いため count は null。
      const amount = record.payout_amount_snapshot ?? assignment.contractor_payout_amount
      total += amount
      breakdown.push({ recordId: record.id, clientName, count: null, amount, matchNames, ...payment })
      continue
    }
    if (record.actual_payout_amount !== null) {
      editorRecords.push({
        recordId: record.id,
        clientName,
        matchNames,
        ...payment,
        confirmed: { amount: record.actual_payout_amount, count: record.delivered_video_count },
        delivery: null,
      })
      total += record.actual_payout_amount
      // 納品チェックの反映時に控えた本数。古い行では未記録（null）のことがあり、
      // その場合は金額だけで照合する（本数を単価から逆算すると単価改定の月にズレる）。
      breakdown.push({
        recordId: record.id,
        clientName,
        count: record.delivered_video_count,
        amount: record.actual_payout_amount,
        matchNames,
        ...payment,
      })
      continue
    }

    const delivery = await checkAssignmentDelivery(
      {
        assignmentId: assignment.id,
        contractorName: contractor.name,
        clientName,
        roleName: assignment.role_name,
        spreadsheetUrl: assignment.spreadsheet_url,
      },
      deliveryTarget.year,
      deliveryTarget.month
    )
    editorRecords.push({
      recordId: record.id,
      clientName,
      matchNames,
      ...payment,
      confirmed: null,
      delivery: {
        status: delivery.status,
        delivered: delivery.delivered,
        expected: delivery.expected,
        revisions: delivery.revisions ?? 0,
        message: delivery.message,
      },
    })
    const suggested = suggestedPayout(delivery, contractor.unit_price)
    if (suggested === null) {
      // 納品予定が0件の月は支払いも0円で確定する。ここを保留にすると
      // 人が確認しても直しようがないのに支払いが止まってしまう。
      // 未達（short）や設定・権限不備（attention）は人が直す余地があるため従来どおり保留。
      if (deliveryTone(delivery) === 'none') {
        notes.push(`${clientName}: 対象月の納品予定なし（¥0）`)
        breakdown.push({ recordId: record.id, clientName, count: 0, amount: 0, matchNames, ...payment })
        // 0円も書き戻す。請求書全体の金額が一致してOKになった時点でこの0円は検証を通った数字であり、
        // 支払額欄を空欄のまま残すと「まだ確認していない行」と見分けが付かなくなるため。
        payouts.push({ recordId: record.id, amount: 0, videoCount: 0 })
        continue
      }
      if (options.tolerateDeliveryHold) {
        unresolvedRecordIds.push(record.id)
        breakdown.push({ recordId: record.id, clientName, count: null, amount: 0, matchNames, ...payment })
        continue
      }
      // ここで打ち切ると、1社直して再チェックするたびに次の1社が出てくる。最後まで調べてまとめて返す。
      deliveryHolds.push(`${clientName}: ${deliveryHoldDetail(delivery, contractor.unit_price)}`)
      continue
    }
    total += suggested
    breakdown.push({ recordId: record.id, clientName, count: delivery.delivered, amount: suggested, matchNames, ...payment })
    payouts.push({ recordId: record.id, amount: suggested, videoCount: delivery.delivered ?? 0 })
    const revisions = delivery.revisions ?? 0
    if (revisions > 0) {
      notes.push(`${clientName}: 納品シートの修正 ${revisions}件は通常の本数に含めていません`)
      sheetRevisions.push({ clientName, count: revisions })
    }
  }

  // 1社だけなら従来どおり1行で伝える。複数あるときは件数を先頭に出し、どの会社が何で止まっているかを1社1行で並べる。
  if (deliveryHolds.length === 1) {
    return { hold: `納品チェックが未反映のため金額を確定できません（${deliveryHolds[0]}）` }
  }
  if (deliveryHolds.length > 1) {
    return {
      hold: `納品チェックが未反映のクライアントが${deliveryHolds.length}件あり、金額を確定できません`,
      holdDetails: deliveryHolds,
    }
  }

  // 月次レコードが無いのは、支払期間の外だから（終了済み・開始前）のことがある。
  const recordedAssignmentIds = new Set(records.map((r) => r.assignment_id))
  const outOfPeriod: OutOfPeriodClient[] = []
  for (const assignment of assignmentRows) {
    const client = assignment.clients
    if (!client || recordedAssignmentIds.has(assignment.id)) continue
    if (isPaymentActiveForMonth(assignment, year, month)) continue
    const start = assignment.payment_start_month ? parseYearMonth(assignment.payment_start_month) : null
    if (!start) continue
    const matchNames = clientMatchNames(client.name, client.aliases)
    if (assignment.payment_count !== null) {
      const last = addMonths(start, assignment.payment_count - 1)
      if (year * 12 + month > last.year * 12 + last.month) {
        outOfPeriod.push({
          clientName: client.name,
          matchNames,
          detail: `支払期間（${formatYearMonth(start)}〜${formatYearMonth(last)}支払い・${assignment.payment_count}回）は終了しています（続ける場合はマスタのアサインで支払回数を延ばしてください）`,
        })
        continue
      }
    }
    if (year * 12 + month < start.year * 12 + start.month) {
      outOfPeriod.push({
        clientName: client.name,
        matchNames,
        detail: `支払開始は${formatYearMonth(start)}支払いからです`,
      })
    }
  }

  // この委託者の担当に入っていない取引先。明細がどのアサインにも当たらなかったときの案内に使う。
  const assignedClientIds = new Set(assignmentRows.map((a) => a.client_id))
  const unassigned: UnassignedClient[] = (
    await db.select({ id: clients.id, name: clients.name, aliases: clients.aliases }).from(clients)
  )
    .filter((client) => !assignedClientIds.has(client.id))
    .map((client) => ({
      clientId: client.id,
      clientName: client.name,
      matchNames: clientMatchNames(client.name, client.aliases),
    }))

  // 立替経費も支払月の行に登録されるため、月次レコードと同じ year / month で引く。
  // 認めた追加費用（category が extra）も同じ表にあり、委託者へ払う点は同じなので支払予定額には両方足す。
  // 一方、請求書の経費明細と突き合わせる相手（expenseTotal）は立替経費だけにする。追加費用まで混ぜると、
  // 経費明細の合計と合わなくなって経費のNGが出てしまう。
  // 認めた追加費用を請求書ではなく委託者×支払月で引くのは、修正版が出し直されたとき（別の請求書として届く）に
  // 同じ追加費用をもう一度聞かず、二重に認めてしまうのを防ぐため。
  const expenseRows = await db
    .select({ amount: expenses.amount, category: expenses.category, itemKey: expenses.invoice_item_key })
    .from(expenses)
    .where(and(inArray(expenses.assignment_id, assignmentIds), eq(expenses.year, year), eq(expenses.month, month)))
  const expenseTotal = expenseRows.filter((e) => e.category !== 'extra').reduce((sum, e) => sum + e.amount, 0)
  const approvedExtraTotal = expenseRows.filter((e) => e.category === 'extra').reduce((sum, e) => sum + e.amount, 0)
  total += expenseRows.reduce((sum, e) => sum + e.amount, 0)
  const approvedExtraKeys = new Set(
    expenseRows.filter((e) => e.category === 'extra' && e.itemKey !== null).map((e) => e.itemKey as string)
  )

  return {
    amount: total,
    notes,
    breakdown,
    skipped,
    outOfPeriod,
    unassigned,
    expenseTotal,
    approvedExtraKeys,
    payouts,
    unresolvedRecordIds,
    sheetRevisions,
    approvedExtraTotal,
    editorRecords,
  }
}

// 明細の無い請求書では「いくらズレたか」しか分からない。編集者への支払いは本数×単価なので、
// 差額が単価で割り切れるなら本数に換算して添える（何本分の食い違いかが分かれば当たる先が絞れる）。
function unitCountHint(contractor: ContractorRow, diff: number): string {
  if (contractor.contractor_type !== 'video_editor' || contractor.unit_price <= 0) return ''
  const abs = Math.abs(diff)
  if (abs === 0 || abs % contractor.unit_price !== 0) return ''
  return `（単価${yen(contractor.unit_price)}の${abs / contractor.unit_price}本分に相当）`
}

// 差出人名からマスタの委託者を1人に絞る。完全一致を先に試し、見つからない場合だけ
// 片方向の包含（「山田太郎」と「山田太郎（個人事業主）」など）に緩める。
// 正式名だけでなく別名（aliases）も候補に含める。parseClientAliases はクライアント側で
// 作った関数だが中身はカンマ区切り文字列を配列にするだけの汎用処理のため、名前を変えずここでも使う。
async function resolveContractor(issuer: string): Promise<{ contractor: ContractorRow } | { hold: string }> {
  const target = normalizeName(issuer)
  const all = await db
    .select({
      id: contractors.id,
      name: contractors.name,
      contractor_type: contractors.contractor_type,
      unit_price: contractors.unit_price,
      chatwork_account_id: contractors.chatwork_account_id,
      aliases: contractors.aliases,
    })
    .from(contractors)
  const candidates = all
    .map((c) => ({
      ...c,
      names: [...new Set([normalizeName(c.name), ...parseClientAliases(c.aliases).map(normalizeName)])].filter(
        (n) => n.length > 0
      ),
    }))
    .filter((c) => c.names.length > 0)

  let matched = candidates.filter((c) => c.names.some((n) => n === target))
  if (matched.length === 0) {
    matched = candidates.filter((c) => c.names.some((n) => n.includes(target) || target.includes(n)))
  }

  if (matched.length === 0) return { hold: `差出人「${issuer}」がマスタに見つかりません` }
  if (matched.length > 1) {
    return { hold: `差出人「${issuer}」の候補が複数あります（${matched.map((c) => c.name).join(' / ')}）` }
  }
  return { contractor: matched[0] }
}

// 委託者の有効なアサインにぶら下がる、指定した支払月の月次レコードを引く。
// 「請求書1件に対応する月次レコードはどれか」の答えを1か所にまとめるための関数。
// 受領チェックの自動付与（markInvoiceReceived）と、保留の手動OK（app/api/invoice-check/[id]/approve）が
// 別々の条件で行を探すと、片方だけ当たって食い違うため共用する。
// スキップした行は払わない行なので含めない（受領の印を付けたり支払額を入れたりする相手ではないため）。
export async function findPayoutMonthlyRecords(
  contractorId: string,
  year: number,
  month: number
): Promise<{ id: string; clientName: string; actualPayoutAmount: number | null }[]> {
  return db
    .select({
      id: monthlyRecords.id,
      clientName: clients.name,
      actualPayoutAmount: monthlyRecords.actual_payout_amount,
    })
    .from(monthlyRecords)
    .innerJoin(assignments, eq(monthlyRecords.assignment_id, assignments.id))
    .innerJoin(clients, eq(assignments.client_id, clients.id))
    .where(
      and(
        eq(assignments.contractor_id, contractorId),
        eq(assignments.active, true),
        eq(monthlyRecords.year, year),
        eq(monthlyRecords.month, month),
        isNull(monthlyRecords.skipped_at)
      )
    )
}

// 手動OKのダイアログに出す割り当て案。対象の月次レコード（targets）ごとに、今の実支払額・支払予定額と
// 「請求書でそのクライアント分として書かれた金額」を並べ、人が行ごとの実支払額を決める材料にする。
// 帰属は照合本体と同じ attributeWorkItems の結果を使う（判定理由の表示と食い違わせないため）。
// 追加費用・経費の明細は別の仕組み（認める／経費登録）で扱うので、ここには出さない。
// payout は支払月。targets は呼び出し側が findPayoutMonthlyRecords で引いた行すべて
// （入力済みの金額が後から合わなくなったときに直せるよう、未入力の行に限らない）。
// 請求書か委託者が引けなければ null（呼び出し側が404を返す）。
export async function buildManualApprovePreview(
  invoiceId: string,
  contractorId: string,
  payout: YearMonth,
  targets: { id: string; clientName: string; currentAmount: number | null }[]
): Promise<InvoiceManualApprovePreview | null> {
  const [invoice] = await db
    .select({
      extracted_amount: invoiceUploads.extracted_amount,
      extracted_items: invoiceUploads.extracted_items,
      rejected_extras: invoiceUploads.rejected_extras,
    })
    .from(invoiceUploads)
    .where(eq(invoiceUploads.id, invoiceId))
  const [contractor] = await db
    .select({
      id: contractors.id,
      name: contractors.name,
      contractor_type: contractors.contractor_type,
      unit_price: contractors.unit_price,
      chatwork_account_id: contractors.chatwork_account_id,
    })
    .from(contractors)
    .where(eq(contractors.id, contractorId))
  if (!invoice || !contractor) return null

  // 保留の文言は使わない（下で行だけ返す）ので、「（支払月）」を添えるかどうかはどちらでもよい。
  const expected = await computeExpectedPayout(contractor, payout.year, payout.month, true, {
    tolerateDeliveryHold: true,
  })
  if ('hold' in expected) {
    // 内訳が組めないと明細の帰属先も決められない。行だけ返し、金額は人に入れてもらう。
    return {
      rows: targets.map((r) => ({
        recordId: r.id,
        clientName: r.clientName,
        currentAmount: r.currentAmount,
        expectedAmount: null,
        billedAmount: null,
      })),
      unassigned: [],
      invoiceAmount: invoice.extracted_amount,
      targetTotal: null,
    }
  }

  const items = invoice.extracted_items ?? []
  const attribution = attributeWorkItems(items, expected.breakdown.map((target) => target.matchNames))
  const unresolved = new Set(expected.unresolvedRecordIds)
  // 対象行の支払予定のうち、支払予定額（expected.amount）に含まれている分。
  // 入力済みの行は今の実支払額がそのまま支払予定に入っているので、それも含める。
  let targetsExpected = 0
  const rows = targets.map((r) => {
    const index = expected.breakdown.findIndex((target) => target.recordId === r.id)
    const inExpected = index >= 0 && !unresolved.has(r.id) ? expected.breakdown[index].amount : null
    targetsExpected += inExpected ?? 0
    return {
      recordId: r.id,
      clientName: r.clientName,
      currentAmount: r.currentAmount,
      // 入力済みの行は「入力前の支払予定」が残っていない。画面は currentAmount との差を見せる。
      expectedAmount: r.currentAmount === null ? inExpected : null,
      billedAmount: index >= 0 ? attribution.billedAmounts[index] : null,
    }
  })

  // 再照合は「未承認の追加費用を除いた請求額」と支払予定額を比べる（compareTotalWithExtras）。
  // 支払予定額のうち対象行の分が今回の入力で置き換わるので、残り（経費・認め済みの追加費用）を
  // 請求額から引いた額が、入力の合計の目標になる。
  // 代行者は契約額で照合され、ここで入れた金額は判定に使われないため目標を出さない。
  let targetTotal: number | null = null
  if (contractor.contractor_type === 'video_editor' && invoice.extracted_amount !== null) {
    const extras = decideExtraItems(items, expected.approvedExtraKeys, new Set(invoice.rejected_extras ?? []))
    const total = compareTotalWithExtras(invoice.extracted_amount, expected.amount, extras)
    targetTotal = total.billedWithoutExtras - (expected.amount - targetsExpected)
  }

  return {
    rows,
    unassigned: attribution.unassigned.map((item) => ({ label: item.label, amount: item.amount })),
    invoiceAmount: invoice.extracted_amount,
    targetTotal,
  }
}

// 照合OK＝「その委託者からその月の請求書が正しく届いた」ということなので、
// 月次レコードの受領チェックを人手を介さず付ける。
// 既に日時が入っている行は上書きしない（画面のトグルAPIと同じく「最初にチェックした日時」を正とする）。
// marked（今回付けた件数）と total（対象レコード数）を分けて返すのは、
// 「全件が既に受領済み」＝同じ月の請求書が二重に届いた可能性を呼び出し側で伝えるため。
async function markInvoiceReceived(
  contractorId: string,
  year: number,
  month: number
): Promise<{ marked: number; total: number }> {
  const existing = await findPayoutMonthlyRecords(contractorId, year, month)
  if (existing.length === 0) return { marked: 0, total: 0 }

  const updated = await db
    .update(monthlyRecords)
    .set({ invoice_received_at: new Date().toISOString() })
    .where(
      and(
        inArray(monthlyRecords.id, existing.map((r) => r.id)),
        isNull(monthlyRecords.invoice_received_at)
      )
    )
    .returning({ id: monthlyRecords.id })

  return { marked: updated.length, total: existing.length }
}

// 照合に使った納品実績（本数・金額）を月次レコードへ書き戻す。ダッシュボードの「反映」ボタンと同じ2列を
// 同じ意味で埋めるので、どちらの経路で入っても後続の集計は変わらない。
// where に isNull を重ねているのは、computeExpectedPayout の時点で実支払額入りの行を外しているとはいえ、
// 読み取りから書き込みまでの間に人が手で入れた値を消してしまわないための二重の歯止め。
async function applyDeliveryPayouts(
  payouts: DeliveryPayoutApply[]
): Promise<{ applied: number; amount: number }> {
  let applied = 0
  let amount = 0
  for (const p of payouts) {
    const updated = await db
      .update(monthlyRecords)
      .set({ actual_payout_amount: p.amount, delivered_video_count: p.videoCount })
      .where(and(eq(monthlyRecords.id, p.recordId), isNull(monthlyRecords.actual_payout_amount)))
      .returning({ id: monthlyRecords.id })
    if (updated.length === 0) continue
    applied += 1
    amount += p.amount
  }
  return { applied, amount }
}

// 「2026-07_中井美由紀_請求書.pdf」の形に揃える。保存先は月別サブフォルダだが、
// 名前にも対象年月を残すのは、あとでフォルダの外へ移動されても何月分か分かるようにするため。
// 委託者名を挟むのは「請求書.pdf」のような同名ファイルが重なっても誰の分か分かるようにするため。
function driveFileName(year: number, month: number, contractorName: string, originalName: string): string {
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  return `${prefix}_${sanitizeFileNamePart(contractorName)}_${sanitizeFileNamePart(originalName)}`
}

// 照合OKの請求書PDFをドライブへ保存する。PDF本体は1件で数MBになりうるため、
// 実際に保存する時だけ読み出す（毎回の再チェックで読むと転送量が無駄になる）。
async function saveInvoiceToDrive(
  id: string,
  contractorName: string,
  year: number,
  month: number
): Promise<DriveUploadOutcome> {
  const [file] = await db
    .select({ file_name: invoiceUploads.file_name, file_data: invoiceUploads.file_data })
    .from(invoiceUploads)
    .where(eq(invoiceUploads.id, id))
  if (!file) return { error: 'PDF本体を取得できませんでした' }
  return uploadFileToDrive(driveFileName(year, month, contractorName, file.file_name), file.file_data, year, month)
}

// チェック1回分を履歴（invoice_check_history）に積む。履歴は後から経緯を追うための控えで、
// 書けなくても判定そのものは済んでいるため、失敗はログに残すだけにしてチェック本体は成功させる。
async function appendCheckHistory(entry: {
  uploadId: string
  trigger: InvoiceCheckTrigger
  status: InvoiceCheckStatus
  checkNotes: string
  extractedAmount: number | null
  expectedAmount: number | null
  ngReasons: InvoiceNgReason[]
  extraItems: InvoiceExtraItem[]
}): Promise<void> {
  try {
    await db.insert(invoiceCheckHistory).values({
      upload_id: entry.uploadId,
      trigger: entry.trigger,
      status: entry.status,
      check_notes: entry.checkNotes,
      extracted_amount: entry.extractedAmount,
      expected_amount: entry.expectedAmount,
      ng_reasons: entry.ngReasons,
      extra_items: entry.extraItems,
    })
  } catch (err) {
    console.error('[invoice-check] appendCheckHistory failed:', err)
  }
}

// 委託者への返信の下書きを、今回の判定に合わせて作り直す。
// 下書きを作るのは OK / NG で委託者が分かっているときだけ。保留はこちら側の設定不足
// （マスタ未登録・納品チェック未反映など）が原因のことが多く、相手に送る内容ではないため作らない。
// 触るのは state が draft の行だけにする。送信済み（sent）は相手に届いた文面の記録、
// 送らない（skipped）は人が決めた結果で、どちらも再チェックで書き換えてはいけない。
// 例外は1つだけ。NGの連絡を済ませた（または送らないと決めた）請求書がOKに変わったとき。
// これは同じ連絡のやり直しではなく「直してもらえたので受領します」という別の連絡なので、
// NGの控えを sent_history へ退避してから、行を受領の下書きに開き直す。
// 履歴と同じく、失敗してもチェック本体は成功させる。
async function syncReplyDraft(
  uploadId: string,
  draft: {
    kind: InvoiceReplyKind
    contractorName: string
    chatworkAccountId: string | null
    month: number | null
    amount: number | null
    reasons: InvoiceNgReason[]
    approvedExtras: { label: string; amount: number | null }[]
  } | null,
  origin: string
): Promise<void> {
  try {
    if (!draft) {
      await db
        .delete(invoiceReplies)
        .where(and(eq(invoiceReplies.upload_id, uploadId), eq(invoiceReplies.state, 'draft')))
      return
    }
    // 受付URLは催促（app/api/invoice-reminder）と同じ作り方。修正版の送り先が要るのはNGだけなので、
    // OKのときはトークンを読みにいかない。
    const url = draft.kind === 'ng' ? `${origin}/invoice/${await getOrCreateInvoiceUploadToken()}` : ''
    const body = buildInvoiceReplyBody(
      {
        kind: draft.kind,
        name: draft.contractorName,
        chatworkAccountId: draft.chatworkAccountId,
        month: draft.month,
        amount: draft.amount,
        reasons: draft.reasons,
        approvedExtras: draft.approvedExtras,
        url,
      },
      {
        ok: INVOICE_REPLY_OK_TEMPLATE,
        okExtras: INVOICE_REPLY_OK_EXTRAS_TEMPLATE,
        ng: INVOICE_REPLY_NG_TEMPLATE,
        unknownMonth: INVOICE_REPLY_UNKNOWN_MONTH,
        reasons: INVOICE_REPLY_REASON_TEMPLATES,
      }
    )
    // 「無ければ作る・draft なら作り直す・それ以外は触らない」を1文で行う。先に読んでから分岐すると、
    // 読んだ直後に人が送信したとき、送信済みの行を下書きで上書きしてしまう。
    await db
      .insert(invoiceReplies)
      .values({ upload_id: uploadId, kind: draft.kind, draft_body: body })
      .onConflictDoUpdate({
        target: invoiceReplies.upload_id,
        set: { kind: draft.kind, draft_body: body, updated_at: new Date().toISOString() },
        setWhere: eq(invoiceReplies.state, 'draft'),
      })
    if (draft.kind === 'ok') {
      // 上の1文のあとに行う。行が無かった・draft だった場合は既に kind=ok になっているので、この更新は空振りする。
      // 控えに入れる文面は、送ったものを優先し、送っていなければ下書き。右辺はすべて更新前の値で評価される。
      await db
        .update(invoiceReplies)
        .set({
          kind: 'ok',
          state: 'draft',
          draft_body: body,
          sent_body: null,
          sent_at: null,
          chatwork_message_id: null,
          sent_history: sql`coalesce(${invoiceReplies.sent_history}, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('kind', ${invoiceReplies.kind}, 'outcome', ${invoiceReplies.state}, 'body', coalesce(${invoiceReplies.sent_body}, ${invoiceReplies.draft_body}), 'at', ${invoiceReplies.sent_at}))`,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(invoiceReplies.upload_id, uploadId),
            eq(invoiceReplies.kind, 'ng'),
            inArray(invoiceReplies.state, ['sent', 'skipped'])
          )
        )
    }
  } catch (err) {
    console.error('[invoice-check] syncReplyDraft failed:', err)
  }
}

// 受け付けた請求書1件を自動照合し、結果を同じ行に書き戻す。
// 受付直後・再読み取り後・画面からの再チェック・手動修正後で同じ処理を使う。
// trigger はどの操作で走ったか（履歴に残す）。origin は呼び出し元リクエストのオリジンで、
// 返信の下書きに入れる受付URLの組み立てに使う（環境ごとにドメインが違うため固定値にしない）。
// manuallyEdited は「今の extracted_* が人の手入力か」。true=手動修正直後 / false=AIが読み直した直後 /
// 未指定=値は変わっていないので前回の判定理由から引き継ぐ、の3通りで呼び分ける。
// 行が無ければ null（呼び出し側が404を返す）。
export async function checkInvoiceAndSave(
  id: string,
  // manualOk は「人が見てOKにする」の指定。true=OKにする / false=取り消す / 未指定=前回の判定理由から引き継ぐ。
  options: { trigger: InvoiceCheckTrigger; origin: string; manuallyEdited?: boolean; manualOk?: boolean }
): Promise<InvoiceCheckOutcome | null> {
  const [row] = await db
    .select({
      extracted_amount: invoiceUploads.extracted_amount,
      extracted_issuer: invoiceUploads.extracted_issuer,
      extracted_addressee: invoiceUploads.extracted_addressee,
      extracted_year: invoiceUploads.extracted_year,
      extracted_month: invoiceUploads.extracted_month,
      extracted_items: invoiceUploads.extracted_items,
      extract_error: invoiceUploads.extract_error,
      check_notes: invoiceUploads.check_notes,
      confirmed_cautions: invoiceUploads.confirmed_cautions,
      rejected_extras: invoiceUploads.rejected_extras,
      drive_file_id: invoiceUploads.drive_file_id,
      drive_link: invoiceUploads.drive_link,
    })
    .from(invoiceUploads)
    .where(eq(invoiceUploads.id, id))
  if (!row) return null

  // 読み取れていない請求書は判定材料が無い。ここで hold にすると「照合した結果の保留」と区別できず、
  // 先に再読み取りが必要であることが伝わらないため、status は pending のまま触らない。
  if (row.extract_error) {
    return { skipped: 'AIの読み取りに失敗しているため照合できません。先に再読み取りを行ってください。' }
  }

  // 人が確認済みにした注意のキー。Set にしてから注意の生成へ渡す（明細1行ごとに毎回照合するため）。
  const confirmedCautions = new Set(row.confirmed_cautions ?? [])

  const notes: string[] = []
  let hasNg = false
  let hasHold = false
  // 印を付けて保存するのは、画面がNG・保留だけを既定表示にできるようにするため。
  // 保存形式は「[NG] 本文」の1行1件（lib/invoice-notes）。
  // NGは理由の控え（ngReasons）も同時に積む。言い換えを用意していないNGは本文をそのまま持たせ、
  // 相手への文面から黙って抜け落ちないようにする。
  const ngReasons: InvoiceNgReason[] = []
  const record = (verdict: Verdict, note: string, reason?: InvoiceNgReason) => {
    notes.push(formatInvoiceNote(verdict, note))
    if (verdict === 'ng') {
      hasNg = true
      ngReasons.push(reason ?? { kind: 'other', text: note })
    }
    if (verdict === 'hold') hasHold = true
  }

  // 手動修正の事実は check_notes にしか残らないうえ、再チェックのたびに notes は作り直される。
  // 呼び出し側が値を触っていないとき（未指定）だけ前回の印を引き継ぐことで、
  // 「AIが読んだ値か人が直した値か」を再チェックを挟んでも見分けられる状態に保つ。
  const manuallyEdited = options.manuallyEdited ?? hasInvoiceNoteMark(row.check_notes, 'fixed')
  if (manuallyEdited) notes.push(formatInvoiceNote('fixed', INVOICE_MANUAL_EDIT_NOTE))

  // ─── A. 差出人 → 委託者の特定 ───────────────────────────────
  let contractor: ContractorRow | null = null
  if (!row.extracted_issuer) {
    record('hold', '差出人が読み取れません')
  } else {
    const resolved = await resolveContractor(row.extracted_issuer)
    if ('hold' in resolved) {
      record('hold', resolved.hold)
    } else {
      contractor = resolved.contractor
      record('ok', `差出人「${row.extracted_issuer}」→ 委託者「${contractor.name}」を特定しました`)
    }
  }

  // ─── B. 対象月の解決 ───────────────────────────────────────
  let resolvedYear: number | null = null
  let resolvedMonth: number | null = null
  // 照合に使う支払月。編集者・代行者とも記載月の翌月になる（理由は payoutMonthOf のコメント）。
  // 委託者が特定できていなければ導出できないので null のままにする（下のCごと見送られる）。
  let payout: { year: number; month: number } | null = null
  if (row.extracted_month === null) {
    record('hold', '対象月が読み取れません')
  } else {
    resolvedMonth = row.extracted_month
    resolvedYear = resolveYear(row.extracted_month, row.extracted_year)
    payout = contractor ? payoutMonthOf(resolvedYear, resolvedMonth) : null
    // 記載月と支払月は必ずずれるため、どちらの月で何を見たのかを書かないと判定理由が読み解けない。
    // 編集者は納品月も分かった方が手がかりになるため両方書き、代行者は支払月だけ書く。
    const monthNote =
      !payout || !contractor
        ? ' '
        : contractor.contractor_type === 'video_editor'
          ? `（${resolvedMonth}月納品・${payout.month}月支払い）`
          : `（${payout.month}月支払い）`
    record('ok', `対象月は ${resolvedYear}年${resolvedMonth}月分${monthNote}として照合しました`)
  }

  // ─── C. 金額の照合 ─────────────────────────────────────────
  let expectedAmount: number | null = null
  // expected はこのブロックのスコープから出られないため、後段のOK判定で使う納品実績だけ外へ持ち出す。
  let deliveryPayouts: DeliveryPayoutApply[] = []
  // 追加費用の明細と今の扱い。支払予定が出せたときだけ埋まる（認め済みかどうかは支払月の経費を
  // 引かないと分からないため。委託者や月が決まらない間は、そもそも認める先のアサインも選べない）。
  let extraItems: InvoiceExtraItem[] = []
  // 追加費用の扱い（認め済み・認めない・未決定）を判定理由に積む。照合の方式によらず同じ。
  // 正当な追加費用かどうかは請求書からは分からないため、人が決めるまでNGにはせず保留にして問いかける。
  // 問いかけは record() を通さず専用の印（確認）で積む。保留の印にすると、マスタや納品シートを
  // 直せば消える他の保留と見分けが付かなくなるため。
  const recordExtras = (extras: InvoiceExtraItem[]) => {
    for (const extra of extras) {
      const shown = `${extraItemTitle(extra.label)} ${extra.amount === null ? '金額不明' : yen(extra.amount)}（${extra.label}）`
      if (extra.decision === 'approved') {
        record('ok', `${shown}は認め済みです（支払予定に含めています）`)
      } else if (extra.decision === 'rejected') {
        record('ng', `${shown}は認めていません`, { kind: 'extra_rejected', label: extra.label, amount: extra.amount })
      } else {
        notes.push(formatInvoiceNote('confirm', `${shown}を認めますか？`))
        hasHold = true
      }
    }
  }
  // 納品シートに修正の行があるのに、請求書に修正費の行が無い。修正費を取らない取り決めのこともあるので
  // 判定は動かさず注意として見せるだけにする（請求漏れか、取らない分かを人が確かめられるように）。
  const recordSheetRevisions = (sheetRevisions: { clientName: string; count: number }[], extras: InvoiceExtraItem[]) => {
    if (sheetRevisions.length === 0 || extras.some((extra) => isRevisionLabel(extra.label))) return
    const where = sheetRevisions.map((r) => `${r.clientName} ${r.count}件`).join('、')
    notes.push(formatInvoiceNote('caution', `納品シートに修正の行があります（${where}）が、請求書に修正費の記載がありません`))
  }
  // 明細の照合に付く支払回数の確認と、担当外の取引先の保留を積む。
  const recordItemNotes = (countNotes: InvoicePaymentCountNote[], unassignedNotes: InvoiceUnassignedNote[]) => {
    // 支払回数の確認結果は record() を通さず直接積む。回数が合わなくても請求額そのものが
    // 誤っているとは限らないため、判定（status）は動かさず注意として見せるだけにする。
    for (const note of countNotes) {
      notes.push(formatInvoiceNote(note.mark, note.note))
    }
    // 担当に入っていない取引先の明細は保留にする。支払いを記録する先（月次レコード）が無く、
    // そのまま通すとこの明細の支払いが記録から漏れるため。ボタンの行き先は、直後の assignLink 行に持たせる。
    for (const note of unassignedNotes) {
      record('hold', note.note)
      notes.push(formatInvoiceNote('assignLink', formatAssignLink(note.assignLink)))
    }
  }

  if (contractor && payout) {
    const items = row.extracted_items ?? []
    // 編集者の請求書に業務明細があるときは、請求書の明細を正にして支払額を決め、納品シートは
    // 合計本数の上限としてだけ使う（lib/invoice-judge の judgeEditorInvoiceByCap）。
    // 明細の無い請求書・業務明細の無い請求書と代行者は、従来どおり支払予定額との突き合わせで判定する。
    const editorCap =
      contractor.contractor_type === 'video_editor' && items.some((item) => effectiveItemKind(item) === 'work')
    const expected = await computeExpectedPayout(contractor, payout.year, payout.month, payout.month !== resolvedMonth, {
      tolerateDeliveryHold: editorCap,
    })
    if ('hold' in expected) {
      record('hold', expected.hold)
      for (const detail of expected.holdDetails ?? []) record('hold', detail)
    } else if (editorCap) {
      extraItems = decideExtraItems(items, expected.approvedExtraKeys, new Set(row.rejected_extras ?? []))
      const judged = judgeEditorInvoiceByCap({
        items,
        invoiceAmount: row.extracted_amount,
        unitPrice: contractor.unit_price,
        records: expected.editorRecords,
        skipped: expected.skipped,
        outOfPeriod: expected.outOfPeriod,
        unassigned: expected.unassigned,
        expenseTotal: expected.expenseTotal,
        approvedExtraTotal: expected.approvedExtraTotal,
        extraItems,
        payout,
        deliveryMonth: deliveryTargetMonth(payout.year, payout.month),
        confirmedCautions,
        contractor,
      })
      expectedAmount = judged.expectedAmount
      deliveryPayouts = judged.payouts
      // 従来の算出の補足（納品予定なし・修正の行など）は全クライアント分のため出さない。
      // スキップ中のクライアントだけは、請求書に載らない理由として残す。
      for (const client of expected.skipped) record('ok', skippedPayoutNote(client.clientName))
      for (const item of judged.results) record(item.verdict, item.note, item.reason)
      recordExtras(extraItems)
      // 修正費の注意は、請求書に載ったクライアントの分だけ（載らなかった分は今回の請求の対象外のため）。
      recordSheetRevisions(judged.sheetRevisions, extraItems)
      recordItemNotes(judged.countNotes, judged.unassignedNotes)
    } else {
      expectedAmount = expected.amount
      deliveryPayouts = expected.payouts
      for (const note of expected.notes) record('ok', note)
      // 明細が読めていれば、合計が合わない理由をクライアント単位まで落として出す。
      extraItems = decideExtraItems(items, expected.approvedExtraKeys, new Set(row.rejected_extras ?? []))
      // 本数換算は明細が無いときの代わりの手がかり。明細があれば下で内訳ごとに出るため付けない。
      const resolvedContractor = contractor
      const total = compareInvoiceTotal(row.extracted_amount, expected.amount, extraItems, (diff) =>
        items.length === 0 ? unitCountHint(resolvedContractor, diff) : ''
      )
      record(total.verdict, total.note, total.reason)
      recordExtras(extraItems)
      recordSheetRevisions(expected.sheetRevisions, extraItems)
      // ─── D. 明細（クライアント別内訳）の照合 ──────────────────
      // 合計が一致していても内訳が入れ替わっている（相殺）ことがあるため、合計とは独立して見る。
      // 内訳の無い請求書（空配列）は従来どおり合計だけで判定する。ここで内訳を要求すると
      // 「明細を書かない」書式の請求書が全件NGになってしまう。
      if (items.length > 0) {
        const compared = compareInvoiceItems(
          items,
          expected.breakdown,
          expected.skipped,
          expected.outOfPeriod,
          expected.unassigned,
          expected.expenseTotal,
          row.extracted_amount,
          payout,
          confirmedCautions,
          contractor
        )
        for (const item of compared.results) {
          record(item.verdict, item.note, item.reason)
        }
        recordItemNotes(compared.countNotes, compared.unassignedNotes)
      }
    }
  } else if (row.extracted_amount === null) {
    // 委託者・対象月が決まらない場合も、金額そのものが読めていないことは別の問題として残す。
    record('hold', '請求額が読み取れません')
  }

  // ─── 宛名チェック ──────────────────────────────────────────
  if (!row.extracted_addressee) {
    record('hold', '宛名が読み取れません')
  } else {
    const addressee = normalizeName(row.extracted_addressee)
    const company = normalizeName(COMPANY_NAME)
    const matches = addressee === company || addressee.includes(company) || company.includes(addressee)
    if (matches) record('ok', `宛名「${row.extracted_addressee}」は自社宛です`)
    else {
      record('ng', `宛名が自社宛ではありません（「${row.extracted_addressee}」→ 正: ${COMPANY_NAME}）`, {
        kind: 'addressee',
        actual: row.extracted_addressee,
        correct: COMPANY_NAME,
      })
    }
  }

  const autoStatus: InvoiceCheckStatus = hasNg ? 'ng' : hasHold ? 'hold' : 'ok'

  // ─── 人が確認してOKにした請求書 ─────────────────────────────
  // 支払い済みの過去分や、金額を別で調整済みの請求書は、自動照合では直しようのないNG・保留が残り続ける。
  // 人が見て問題ないと決めたものは、理由を記録に残したまま判定だけOKにする。
  // 読み取り結果が変わったとき（手動修正・再読み取り）は、OKにした前提が変わるので引き継がない。
  const manualOkRequested =
    options.manualOk ?? (options.manuallyEdited === undefined && hasInvoiceNoteMark(row.check_notes, 'manualOk'))
  // 自動照合でOKになったなら印は要らない（人が上書きした結果ではなくなるため）。
  const manualOk = manualOkRequested && autoStatus !== 'ok'
  if (manualOk) {
    // NG・保留の行を色付きのまま残すと「まだ対応が要る」ように見える。OKの行（詳細を開いたときだけ出る）へ
    // 落とし、自動照合では何だったのかを文頭に添えて記録として読めるようにする。
    const demoted = parseInvoiceNotes(notes.join('\n')).map((line) =>
      line.mark === 'ng' || line.mark === 'hold' || line.mark === 'caution' || line.mark === 'confirm'
        ? formatInvoiceNote('ok', `自動照合では${INVOICE_NOTE_MARKS[line.mark]}: ${line.text}`)
        : line.mark
          ? formatInvoiceNote(line.mark, line.text)
          : line.text
    )
    notes.splice(
      0,
      notes.length,
      formatInvoiceNote('manualOk', `人が見てOKにしました（自動照合では${INVOICE_NOTE_MARKS[autoStatus === 'ng' ? 'ng' : 'hold']}・支払額は変えていません）`),
      ...demoted
    )
    // 相手へ直しを求める理由ではなくなるため、履歴にも返信にも持ち込まない。
    ngReasons.length = 0
  }
  const status: InvoiceCheckStatus = manualOk ? 'ok' : autoStatus

  // 受領チェックの自動付与はOKのときだけ。ng/hold は中身が確定していないため月次レコードには一切触らない。
  // 付与の結果も判定理由に残す（画面に出るのは check_notes だけなので、ここに書かないと何が起きたか分からない）。
  // 受領チェックは月次レコードに付く印なので、参照先は照合と同じ支払月に揃える（記載月ではない）。
  if (status === 'ok' && contractor && payout) {
    const received = await markInvoiceReceived(contractor.id, payout.year, payout.month)
    if (received.marked > 0) {
      notes.push(formatInvoiceNote('received', `請求書受領チェックを自動で付けました（${received.marked}件）`))
    } else if (received.total > 0) {
      notes.push(
        formatInvoiceNote('received', '受領チェックは既に付いていました（別の請求書で受領済みの可能性があります）')
      )
    }

    // 照合が通った時点で「請求額＝納品実績」が確認できているので、その根拠になった本数・金額を
    // ダッシュボード側にも残す。ここで書かないと編集者の支払額欄は空のままになる。
    // 受領チェック・ドライブ保存と同じくOKのときだけ行う（NG・保留は中身が確定していないため
    // 月次レコードには一切触らない）。
    // 手動OKは金額が合った結果ではないので書き戻さない（支払額を変えずにOKにする操作のため）。
    if (deliveryPayouts.length > 0 && !manualOk) {
      const applied = await applyDeliveryPayouts(deliveryPayouts)
      if (applied.applied > 0) {
        notes.push(
          formatInvoiceNote('applied', `納品実績から支払額を反映しました（${applied.applied}件・計${yen(applied.amount)}）`)
        )
      }
    }
  }

  // Googleドライブへの保存。check_notes は再チェックのたびに丸ごと作り直されるため、
  // 保存済みの行はここで印を付け直さないと「保存された」事実が画面から消える。
  // 判定がNG・保留に変わった行でも印は残す（ファイルは実際にドライブに在るため）。
  let driveFileId = row.drive_file_id
  let driveLink = row.drive_link
  if (driveFileId) {
    notes.push(formatInvoiceNote('saved', 'Googleドライブに保存済みです'))
  } else if (status === 'ok' && contractor && payout) {
    // 保存するのはOKになった請求書だけ。NG・保留のものまで上げると、人が直したあとの版と二重に残る。
    // 保存先フォルダ・ファイル名は支払月（payout）で揃える。経理はドライブを「支払った月」で
    // 整理して確認するため（記載月だと編集者の請求書だけ1か月ズレて別フォルダに入ってしまう）。
    const saved = await saveInvoiceToDrive(id, contractor.name, payout.year, payout.month)
    if ('fileId' in saved) {
      driveFileId = saved.fileId
      driveLink = saved.link
      notes.push(formatInvoiceNote('saved', `Googleドライブ（${saved.folderName}）に保存しました`))
    } else if ('error' in saved) {
      // 保存の失敗は請求内容の問題ではないので status は ok のまま。落とすと「請求が誤っている」と誤読される。
      // drive_file_id が null のままなので、次の再チェックで自動的に再試行される。
      notes.push(formatInvoiceNote('saveFailed', `${saved.error}（再チェックで再試行できます）`))
    }
    // disabled（環境変数が未設定＝機能を使わない運用）のときは何も残さない。
  }

  const result: InvoiceCheckResult = {
    status,
    contractorId: contractor?.id ?? null,
    resolvedYear,
    resolvedMonth,
    expectedAmount,
    notes,
  }

  // マスタ修正後の再チェックで前回の判定が残らないよう、特定できなかった項目は null で上書きする。
  await db
    .update(invoiceUploads)
    .set({
      status,
      contractor_id: result.contractorId,
      resolved_year: resolvedYear,
      resolved_month: resolvedMonth,
      expected_amount: expectedAmount,
      check_notes: notes.join('\n'),
      extra_items: extraItems,
      checked_at: new Date().toISOString(),
      // 保存できなかった場合は元の値（null）のまま。次の再チェックで再試行させるため消さない。
      drive_file_id: driveFileId,
      drive_link: driveLink,
    })
    .where(eq(invoiceUploads.id, id))

  await appendCheckHistory({
    uploadId: id,
    trigger: options.trigger,
    status,
    checkNotes: notes.join('\n'),
    extractedAmount: row.extracted_amount,
    expectedAmount,
    ngReasons,
    extraItems,
  })

  // OKの文面には請求額を入れるため、金額が無ければ下書きにしない（OKは金額が一致した結果なので
  // 実際には必ず入っているが、型の上では null がありうる）。
  // 手動OKでは下書きを作らない。OKの文面は「請求額で受領した」と伝えるもので、金額が合っていない
  // 請求書にそのまま出すと、支払う額と違う金額を相手に約束してしまう。
  const replyKind: InvoiceReplyKind | null = manualOk
    ? null
    : status === 'ng'
      ? 'ng'
      : status === 'ok' && row.extracted_amount !== null
        ? 'ok'
        : null
  await syncReplyDraft(
    id,
    contractor && replyKind
      ? {
          kind: replyKind,
          contractorName: contractor.name,
          chatworkAccountId: contractor.chatwork_account_id,
          month: resolvedMonth,
          amount: row.extracted_amount,
          reasons: ngReasons,
          approvedExtras: extraItems.filter((extra) => extra.decision === 'approved'),
        }
      : null,
    options.origin
  )

  return result
}
