import 'server-only'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { assignments, contractors, expenses, invoiceUploads, monthlyRecords } from '@/lib/schema'
import { checkAssignmentDelivery } from '@/lib/sheets'
import { deliveryTargetMonth, deliveryTone, suggestedPayout } from '@/lib/delivery-status'
import { COMPANY_NAME } from '@/lib/config'
import { nowJST } from '@/lib/dates'
import { uploadPdfToDrive } from '@/lib/google-drive'
import { INVOICE_MANUAL_EDIT_NOTE, formatInvoiceNote, hasInvoiceNoteMark } from '@/lib/invoice-notes'
import {
  CAUTION_LABEL_SEPARATOR,
  cautionKeyOf,
  clientMatchNames,
  extractItemDate,
  normalizeName,
  resolveItemClient,
} from '@/lib/invoice-match'
import type {
  DeliveryCheckRow,
  DriveUploadOutcome,
  InvoiceCheckOutcome,
  InvoiceCheckResult,
  InvoiceCheckStatus,
  InvoiceExtractedItem,
  InvoicePayoutBreakdownRow,
} from '@/lib/ui-types'

// 3観点（差出人・対象月＋金額・宛名）それぞれの結論。
// - ok   : 一致した
// - ng   : 不一致（人が中身を直す必要がある）
// - hold : 判定材料が足りず結論を出せない（マスタ登録漏れ・納品未反映など）
type Verdict = 'ok' | 'ng' | 'hold'

// 名前の正規化・呼び名の展開・ラベルとの一致判定は lib/invoice-match に集約している
// （経費のその場登録ダイアログでも同じ基準で明細をクライアントへ割り当てるため）。

function yen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`
}

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

type ContractorRow = { id: string; name: string; contractor_type: 'daiko' | 'video_editor'; unit_price: number }

// 照合OKになったときだけ月次レコードへ書き戻す納品実績。請求書チェックの中で納品シートを
// 読んで金額を出せた編集者の行だけが入る（既に実支払額が入っている行・代行者は対象外）。
type DeliveryPayoutApply = { recordId: string; amount: number; videoCount: number }

// notes は算出の途中で人に伝えたい補足（納品予定0件の月など）。金額だけでは
// 「なぜその予定額になったのか」が追えないため、判定理由に混ぜて残す。
// breakdown は合計の内訳（アサイン単位）。合計が合っていても「Aで1本多くBで1本少ない」ように
// 相殺していることがあるため、請求書の明細と突き合わせる相手として合計と一緒に持ち回る。
// expenseTotal（登録済みの立替経費の合計）は breakdown に混ぜず別に持つ。経費の請求は
// クライアント別ではなく「実費の合計」で書かれるため、突き合わせる相手が違うため。
type ExpectedOutcome =
  | {
      amount: number
      notes: string[]
      breakdown: InvoicePayoutBreakdownRow[]
      expenseTotal: number
      payouts: DeliveryPayoutApply[]
    }
  | { hold: string }

// 判定理由に出す立替経費の呼び名。実在のクライアント名と混ざらないよう固定の1語にまとめる。
const EXPENSE_LABEL = '立替経費'

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
  payoutMonthShifted: boolean
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
  const deliveryMonth = deliveryTargetMonth(year, month).month
  let total = 0
  const notes: string[] = []
  const breakdown: InvoicePayoutBreakdownRow[] = []
  const payouts: DeliveryPayoutApply[] = []

  for (const record of records) {
    const assignment = assignmentRows.find((a) => a.id === record.assignment_id)
    if (!assignment) continue
    const client = assignment.clients
    const clientName = client?.name ?? '?'
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
      breakdown.push({ clientName, count: null, amount, matchNames, ...payment })
      continue
    }
    if (record.actual_payout_amount !== null) {
      total += record.actual_payout_amount
      // 納品チェックの反映時に控えた本数。古い行では未記録（null）のことがあり、
      // その場合は金額だけで照合する（本数を単価から逆算すると単価改定の月にズレる）。
      breakdown.push({
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
      deliveryMonth
    )
    const suggested = suggestedPayout(delivery, contractor.unit_price)
    if (suggested === null) {
      // 納品予定が0件の月は支払いも0円で確定する。ここを保留にすると
      // 人が確認しても直しようがないのに支払いが止まってしまう。
      // 未達（short）や設定・権限不備（attention）は人が直す余地があるため従来どおり保留。
      if (deliveryTone(delivery) === 'none') {
        notes.push(`${clientName}: 対象月の納品予定なし（¥0）`)
        breakdown.push({ clientName, count: 0, amount: 0, matchNames, ...payment })
        // 0円も書き戻す。請求書全体の金額が一致してOKになった時点でこの0円は検証を通った数字であり、
        // 支払額欄を空欄のまま残すと「まだ確認していない行」と見分けが付かなくなるため。
        payouts.push({ recordId: record.id, amount: 0, videoCount: 0 })
        continue
      }
      return {
        hold: `納品チェックが未反映のため金額を確定できません（${clientName}: ${deliveryHoldDetail(delivery, contractor.unit_price)}）`,
      }
    }
    total += suggested
    breakdown.push({ clientName, count: delivery.delivered, amount: suggested, matchNames, ...payment })
    payouts.push({ recordId: record.id, amount: suggested, videoCount: delivery.delivered ?? 0 })
  }

  // 立替経費も支払月の行に登録されるため、月次レコードと同じ year / month で引く。
  const expenseRows = await db
    .select({ amount: expenses.amount })
    .from(expenses)
    .where(and(inArray(expenses.assignment_id, assignmentIds), eq(expenses.year, year), eq(expenses.month, month)))
  const expenseTotal = expenseRows.reduce((sum, e) => sum + e.amount, 0)
  total += expenseTotal

  return { amount: total, notes, breakdown, expenseTotal, payouts }
}

// OK行は「本数（無ければ金額） 一致」のコンパクト表記にする。本数と金額を両方書くと
// 冗長なので、本数が分かるとき（編集者）は本数だけ、無いとき（代行者・立替経費）は金額だけを見せる。
function formatMatchNote(count: number | null, amount: number | null): string {
  const value = count !== null ? `${count}本` : amount !== null ? yen(amount) : ''
  return `${value} 一致`
}

// NG行のコンパクト表記。本数がある行（編集者の明細）は本数の相違だけを示し、金額や
// 過不足の向き（多い/少ない）は書かない。ツール側の本数は納品実績のため「実績」と表記する。
// 本数が無い行（代行者・立替経費）や、本数は一致していて金額だけがズレている行は
// 「予定」との金額の相違だけを示す。
function formatMismatchNote(
  isCountBased: boolean,
  billedCount: number | null,
  billedAmount: number | null,
  targetCount: number | null,
  targetAmount: number,
  countDiff: number | null,
  amountDiff: number | null
): string {
  const label = isCountBased ? '実績' : '予定'
  if (isCountBased && billedCount !== null && targetCount !== null && countDiff !== null && countDiff !== 0) {
    return `請求 ${billedCount}本　${label} ${targetCount}本（${Math.abs(countDiff)}本相違）`
  }
  const billedText = billedAmount !== null ? yen(billedAmount) : '金額不明'
  const diffText = amountDiff !== null ? `（${yen(Math.abs(amountDiff))}相違）` : ''
  return `請求 ${billedText}　${label} ${yen(targetAmount)}${diffText}`
}

// 読み取れた値だけを足す。1行でも読めていれば合計は出せるが、全部 null なら比較自体を諦める
// （0として扱うと「0本と請求されている」と誤って指摘してしまう）。
function sumKnown(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null)
  return known.length === 0 ? null : known.reduce((sum, v) => sum + v, 0)
}

// 業務明細に書かれる「N/M」は支払回数（例「運用代行費 19/24」＝全24回中19回目）。
// 数字の並びをそのまま取り、桁数で回数かどうかを見分ける（「2026/8」のような年月を回数と
// 読み違えないよう、4桁以上を含む並びは対象外にする）。
const PAYMENT_COUNT_PATTERN = /(\d+)\s*\/\s*(\d+)/g

type YearMonth = { year: number; month: number }

// 年またぎ（12月+1＝翌年1月、1月-1＝前年12月）は自前の加減算では扱えないため Date に任せる。
function addMonths(base: YearMonth, delta: number): YearMonth {
  const d = new Date(base.year, base.month - 1 + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}

function formatYearMonth(ym: YearMonth): string {
  return `${ym.year}年${ym.month}月`
}

// マスタの支払開始月は date 列（'YYYY-MM-DD'）。日は使わないので年月だけ取り出す。
function parseYearMonth(value: string): YearMonth | null {
  const m = /^(\d{4})-(\d{2})/.exec(value)
  if (!m) return null
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return { year: Number(m[1]), month }
}

// 明細ラベルから支払回数「N回目 / 全M回」を取り出す。回数として成り立たない並び
// （4桁以上＝年月などの別物、0回目、N>M）は読み飛ばし、最初に見つかった回数だけを返す
// （「2026/8分 運用代行費 19/24」のように別の数字が先に来る書き方があるため全体を走査する）。
function extractPaymentCount(label: string): { index: number; total: number } | null {
  for (const [, left, right] of label.matchAll(PAYMENT_COUNT_PATTERN)) {
    if (left.length > 3 || right.length > 3) continue
    const index = Number(left)
    const total = Number(right)
    if (index < 1 || total < 1 || index > total) continue
    return { index, total }
  }
  return null
}

// 支払回数の確認結果1行。ok/ng/hold（判定）とは別枠で、status には影響させない。
// 一致していれば「確認できた」ことを OK として残し、合わないときだけ注意を促す。
type PaymentCountNote = { mark: 'ok' | 'caution'; note: string }

// 注意行の本文。先頭は必ず明細ラベルの原文にする。画面はここからラベルを取り出して
// 確認済みキー（lib/invoice-match の cautionKeyOf）を復元するため、この形を崩さない。
function cautionNote(label: string, body: string): string {
  return `${label}${CAUTION_LABEL_SEPARATOR}${body}`
}

// 明細の支払回数がマスタの支払期間と整合するかを見る。
// 請求書の支払月 P が「全M回中N回目」なら、契約は P-(N-1) 月に始まり P+(M-N) 月で終わる。
// マスタ側の終了月（開始月+回数-1）と突き合わせ、終わりが揃っていれば回数の記載は正しい。
// 突き合わせる相手が無い場合（クライアント未特定・支払期間が「継続」）は、判断できないことを
// そのまま伝えて人に回す（勝手に整合とみなすと、回数のズレを黙って通してしまう）。
// confirmed は人が目視で確認済みにした注意のキー一覧。該当する注意は消さずにOKへ落とす
// （消してしまうと「確認した結果その注意は問題なかった」のか「注意自体が出なくなった」のかが
// 区別できなくなる）。
function checkPaymentCount(
  label: string,
  target: InvoicePayoutBreakdownRow | null,
  payout: YearMonth,
  confirmed: Set<string>
): PaymentCountNote | null {
  const isConfirmed = confirmed.has(cautionKeyOf(label))
  // 「N/M」を台本作成日として書くクライアント（clients.nm_as_date）では、回数として突き合わせると
  // 必ず不整合になる。回数チェックは行わず、記載日の作業実施を人に確かめてもらう案内に切り替える。
  // 日付として読めない並び（「19/24」など）は案内の材料が無いため何も出さない。
  if (target?.nmAsDate) {
    const date = extractItemDate(label)
    if (!date) return null
    if (isConfirmed) return { mark: 'ok', note: cautionNote(label, '作業実施を確認済み') }
    return {
      mark: 'caution',
      note: cautionNote(label, `記載日（${date.month}/${date.day}）の作業実施をご確認ください`),
    }
  }
  const ref = extractPaymentCount(label)
  if (!ref) return null
  const shown = `支払回数（${ref.index}/${ref.total}）`
  const start = target?.paymentStartMonth ? parseYearMonth(target.paymentStartMonth) : null
  const count = target?.paymentCount ?? null
  if (!target || !start || count === null || count < 1) {
    if (isConfirmed) return { mark: 'ok', note: cautionNote(label, '回数を確認済み') }
    // どの明細についての注意かが分からないと確認しようがないため、本文にラベル原文を必ず含める。
    return { mark: 'caution', note: cautionNote(label, '支払回数の記載があります。回数が合っているかご確認ください') }
  }
  const billedEnd = addMonths(payout, ref.total - ref.index)
  const masterEnd = addMonths(start, count - 1)
  if (billedEnd.year === masterEnd.year && billedEnd.month === masterEnd.month) {
    return { mark: 'ok', note: `${target.clientName}　${shown}は支払予定と整合しています` }
  }
  if (isConfirmed) return { mark: 'ok', note: cautionNote(label, '回数を確認済み') }
  return {
    mark: 'caution',
    note: cautionNote(
      label,
      `${target.clientName}の${shown}が支払予定と整合しません（記載どおりなら${formatYearMonth(billedEnd)}終了・マスタは${formatYearMonth(masterEnd)}終了）。ご確認ください`
    ),
  }
}

// 経費明細（交通費など）とツール側に登録済みの立替経費を突き合わせる。
// 経費はクライアント別ではなく実費の合計で請求されるため、クライアント別の内訳とは別枠で見る。
function compareExpenses(
  expenseItems: InvoiceExtractedItem[],
  expenseTotal: number
): { verdict: Verdict; note: string }[] {
  if (expenseItems.length === 0) {
    // 経費が無い月まで指摘すると、立替の無い請求書が全件NGになってしまう。
    if (expenseTotal === 0) return []
    return [{ verdict: 'ng', note: `${EXPENSE_LABEL}: 予定 ${yen(expenseTotal)} が請求書に見当たりません` }]
  }
  const billed = sumKnown(expenseItems.map((i) => i.amount))
  if (billed === null) {
    return [{ verdict: 'hold', note: `${EXPENSE_LABEL}の明細の金額が読み取れず照合できません` }]
  }
  if (expenseTotal === 0) {
    return [
      {
        verdict: 'ng',
        note: `経費 ${yen(billed)} が請求書にありますが、経費が未登録です（ダッシュボードの＋経費から登録してください）`,
      },
    ]
  }
  if (billed === expenseTotal) return [{ verdict: 'ok', note: `経費 ${yen(billed)} 一致` }]
  return [
    {
      verdict: 'ng',
      note: `経費　請求 ${yen(billed)}　登録 ${yen(expenseTotal)}（${yen(Math.abs(billed - expenseTotal))}相違）`,
    },
  ]
}

// 請求書の明細行を、ツール側の内訳（アサイン別の支払予定）へ突き合わせる。
// 合計が一致していても内訳が入れ替わっていることがあるため、クライアント単位で本数・金額まで見る。
// 帰属の決め方は lib/invoice-match の resolveItemClient に集約している（AIが請求書全体から読んだ
// 取引先名を優先し、決まらなければ明細ラベルで照合する）。名前は表記ゆれ・通称が避けられないので
// 「文字列の中に呼び名があるか」まで緩め、1つに絞れない行は判定せず保留として人へ回す。
// 経費明細はクライアントの支払いではないため、ここでは経費どうしで別に照合する。
// 支払回数（「19/24」）の確認は判定（ok/ng/hold）とは別枠の countNotes として返す。明細と
// アサインの対応がここでしか分からない一方、status には影響させたくないため混ぜずに分ける。
function compareInvoiceItems(
  items: InvoiceExtractedItem[],
  breakdown: InvoicePayoutBreakdownRow[],
  expenseTotal: number,
  invoiceAmount: number | null,
  payout: YearMonth,
  confirmedCautions: Set<string>
): { results: { verdict: Verdict; note: string }[]; countNotes: PaymentCountNote[] } {
  const results: { verdict: Verdict; note: string }[] = []
  const countNotes: PaymentCountNote[] = []
  const addCountNote = (label: string, target: InvoicePayoutBreakdownRow | null) => {
    const note = checkPaymentCount(label, target, payout, confirmedCautions)
    if (note) countNotes.push(note)
  }
  // kind を持たない過去の読み取り結果は work とみなす（経費として扱うと本数のズレを見逃すため）。
  const workItems = items.filter((item) => item.kind !== 'expense')
  const expenseItems = items.filter((item) => item.kind === 'expense')
  // 1クライアントを工程ごとに複数行へ分けて書く請求書があるため、突き合わせは
  // 「内訳1行 対 明細n行」で行い、合算してから比べる（1行ずつ比べると両方NGになる）。
  const matchedItems = new Map<number, InvoiceExtractedItem[]>()
  const candidateNames = breakdown.map((target) => target.matchNames)

  for (const item of workItems) {
    const { indexes } = resolveItemClient(item, candidateNames)
    if (indexes.length === 0) {
      // AIが取引先名を読めているのに当たらない＝マスタの名称・別名が足りていない可能性が高い。
      // 読み取れた名称を添えて、別名登録で直せることが分かるようにする。
      const hint = item.client ? `（請求書の記載「${item.client}」はマスタに見つかりません）` : ''
      results.push({ verdict: 'hold', note: `明細「${item.label}」がどのクライアント分か特定できません${hint}` })
      addCountNote(item.label, null)
      continue
    }
    if (indexes.length > 1) {
      results.push({
        verdict: 'hold',
        note: `明細「${item.label}」の候補が複数あります（${indexes.map((i) => breakdown[i].clientName).join(' / ')}）`,
      })
      addCountNote(item.label, null)
      continue
    }
    const index = indexes[0]
    matchedItems.set(index, [...(matchedItems.get(index) ?? []), item])
    addCountNote(item.label, breakdown[index])
  }

  breakdown.forEach((target, index) => {
    const matched = matchedItems.get(index)
    if (!matched) {
      // 予定0円（納品予定なしの月）は請求書に出てこないのが正しい姿なので指摘しない。
      if (target.amount === 0) return
      results.push({ verdict: 'ng', note: `${target.clientName}: 予定 ${yen(target.amount)} が請求書に見当たりません` })
      return
    }
    const billedCount = sumKnown(matched.map((m) => m.count))
    const billedAmount = sumKnown(matched.map((m) => m.amount))
    // 本数はどちらか一方でも欠けていれば比べられない（欠けている側を0とみなすと誤検知になる）。
    const countDiff = billedCount !== null && target.count !== null ? billedCount - target.count : null
    const amountDiff = billedAmount !== null ? billedAmount - target.amount : null
    if (countDiff === null && amountDiff === null) {
      results.push({ verdict: 'hold', note: `${target.clientName}: 明細の本数・金額が読み取れず照合できません` })
      return
    }
    if ((countDiff ?? 0) === 0 && (amountDiff ?? 0) === 0) {
      results.push({ verdict: 'ok', note: `${target.clientName}　${formatMatchNote(billedCount, billedAmount)}` })
      return
    }
    results.push({
      verdict: 'ng',
      note: `${target.clientName}　${formatMismatchNote(
        target.count !== null,
        billedCount,
        billedAmount,
        target.count,
        target.amount,
        countDiff,
        amountDiff
      )}`,
    })
  })

  results.push(...compareExpenses(expenseItems, expenseTotal))

  // 明細の金額を全行読めているときだけ合計との整合を見る。1行でも読めていなければ
  // 差が出るのは当たり前で、指摘されても直しようがない。
  if (invoiceAmount !== null && items.every((item) => item.amount !== null)) {
    const itemsTotal = items.reduce((sum, item) => sum + (item.amount ?? 0), 0)
    if (itemsTotal !== invoiceAmount) {
      results.push({
        verdict: 'hold',
        note: `明細の合計（${yen(itemsTotal)}）と請求額（${yen(invoiceAmount)}）が一致しません（読み取りミスの可能性）`,
      })
    }
  }

  return { results, countNotes }
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
async function resolveContractor(issuer: string): Promise<{ contractor: ContractorRow } | { hold: string }> {
  const target = normalizeName(issuer)
  const all = await db
    .select({
      id: contractors.id,
      name: contractors.name,
      contractor_type: contractors.contractor_type,
      unit_price: contractors.unit_price,
    })
    .from(contractors)
  const candidates = all
    .map((c) => ({ ...c, norm: normalizeName(c.name) }))
    .filter((c) => c.norm.length > 0)

  let matched = candidates.filter((c) => c.norm === target)
  if (matched.length === 0) {
    matched = candidates.filter((c) => c.norm.includes(target) || target.includes(c.norm))
  }

  if (matched.length === 0) return { hold: `差出人「${issuer}」がマスタに見つかりません` }
  if (matched.length > 1) {
    return { hold: `差出人「${issuer}」の候補が複数あります（${matched.map((c) => c.name).join(' / ')}）` }
  }
  return { contractor: matched[0] }
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
  const assignmentRows = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.contractor_id, contractorId), eq(assignments.active, true)))
  if (assignmentRows.length === 0) return { marked: 0, total: 0 }

  const target = and(
    inArray(monthlyRecords.assignment_id, assignmentRows.map((a) => a.id)),
    eq(monthlyRecords.year, year),
    eq(monthlyRecords.month, month)
  )
  const existing = await db.select({ id: monthlyRecords.id }).from(monthlyRecords).where(target)
  if (existing.length === 0) return { marked: 0, total: 0 }

  const updated = await db
    .update(monthlyRecords)
    .set({ invoice_received_at: new Date().toISOString() })
    .where(and(target, isNull(monthlyRecords.invoice_received_at)))
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

// ドライブ上のファイル名に使うと表示や検索が壊れる文字（フォルダ区切り等）を落とす。
// 元のファイル名は外部からアップロードされたもので、何が入っているか保証がない。
function sanitizeFileNamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\r\n]/g, '_').trim()
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
  return uploadPdfToDrive(driveFileName(year, month, contractorName, file.file_name), file.file_data, year, month)
}

// 受け付けた請求書1件を自動照合し、結果を同じ行に書き戻す。
// 受付直後・再読み取り後・画面からの再チェック・手動修正後で同じ処理を使う。
// manuallyEdited は「今の extracted_* が人の手入力か」。true=手動修正直後 / false=AIが読み直した直後 /
// 未指定=値は変わっていないので前回の判定理由から引き継ぐ、の3通りで呼び分ける。
// 行が無ければ null（呼び出し側が404を返す）。
export async function checkInvoiceAndSave(
  id: string,
  options?: { manuallyEdited?: boolean }
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
  const record = (verdict: Verdict, note: string) => {
    notes.push(formatInvoiceNote(verdict, note))
    if (verdict === 'ng') hasNg = true
    if (verdict === 'hold') hasHold = true
  }

  // 手動修正の事実は check_notes にしか残らないうえ、再チェックのたびに notes は作り直される。
  // 呼び出し側が値を触っていないとき（未指定）だけ前回の印を引き継ぐことで、
  // 「AIが読んだ値か人が直した値か」を再チェックを挟んでも見分けられる状態に保つ。
  const manuallyEdited = options?.manuallyEdited ?? hasInvoiceNoteMark(row.check_notes, 'fixed')
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
  if (contractor && payout) {
    const expected = await computeExpectedPayout(contractor, payout.year, payout.month, payout.month !== resolvedMonth)
    if ('hold' in expected) {
      record('hold', expected.hold)
    } else {
      expectedAmount = expected.amount
      deliveryPayouts = expected.payouts
      for (const note of expected.notes) record('ok', note)
      // 明細が読めていれば、合計が合わない理由をクライアント単位まで落として出す。
      const items = row.extracted_items ?? []
      if (row.extracted_amount === null) {
        record('hold', `請求額が読み取れないため金額を照合できません（支払予定 ${yen(expectedAmount)}）`)
      } else if (row.extracted_amount === expectedAmount) {
        record('ok', `支払予定 ${yen(expectedAmount)} と一致`)
      } else {
        const diff = row.extracted_amount - expectedAmount
        // 本数換算は明細が無いときの代わりの手がかり。明細があれば下で内訳ごとに出るため付けない。
        const hint = items.length === 0 ? unitCountHint(contractor, diff) : ''
        record(
          'ng',
          `支払予定 ${yen(expectedAmount)} に対し請求 ${yen(row.extracted_amount)}（差 ${yen(Math.abs(diff))} ${diff > 0 ? '多い' : '少ない'}）${hint}`
        )
      }
      // ─── D. 明細（クライアント別内訳）の照合 ──────────────────
      // 合計が一致していても内訳が入れ替わっている（相殺）ことがあるため、合計とは独立して見る。
      // 内訳の無い請求書（空配列）は従来どおり合計だけで判定する。ここで内訳を要求すると
      // 「明細を書かない」書式の請求書が全件NGになってしまう。
      if (items.length > 0) {
        const compared = compareInvoiceItems(
          items,
          expected.breakdown,
          expected.expenseTotal,
          row.extracted_amount,
          payout,
          confirmedCautions
        )
        for (const item of compared.results) {
          record(item.verdict, item.note)
        }
        // 支払回数の確認結果は record() を通さず直接積む。回数が合わなくても請求額そのものが
        // 誤っているとは限らないため、判定（status）は動かさず注意として見せるだけにする。
        for (const note of compared.countNotes) {
          notes.push(formatInvoiceNote(note.mark, note.note))
        }
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
    else record('ng', `宛名が自社宛ではありません（「${row.extracted_addressee}」→ 正: ${COMPANY_NAME}）`)
  }

  const status: InvoiceCheckStatus = hasNg ? 'ng' : hasHold ? 'hold' : 'ok'

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
    if (deliveryPayouts.length > 0) {
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
      checked_at: new Date().toISOString(),
      // 保存できなかった場合は元の値（null）のまま。次の再チェックで再試行させるため消さない。
      drive_file_id: driveFileId,
      drive_link: driveLink,
    })
    .where(eq(invoiceUploads.id, id))

  return result
}
