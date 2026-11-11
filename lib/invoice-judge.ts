// 請求書チェックの判定の中身（DB・納品シートには触らない）。
// 照合本体（lib/invoice-check）は server-only でDBや納品シートを読むため、そのままでは判定だけを
// 確かめられない。データを集める層（lib/invoice-check）と、集めたデータから結論を出す層（ここ）を分け、
// 判定は入力を渡すだけで確認できるようにしている。server-only や @/lib/db をここで import しないこと。
import type {
  EditorCapJudgeInput,
  EditorCapJudgeResult,
  EditorCapRecord,
  InvoiceCompared,
  InvoiceDeliveryPayoutApply,
  InvoiceExtraItem,
  InvoiceExtractedItem,
  InvoiceOutOfPeriodClient,
  InvoicePaymentCountNote,
  InvoicePaymentTarget,
  InvoicePayoutBreakdownRow,
  InvoiceSkippedClient,
  InvoiceUnassignedClient,
  InvoiceUnassignedNote,
  InvoiceVerdict,
  InvoiceYearMonth,
} from './ui-types'
import {
  CAUTION_LABEL_SEPARATOR,
  attributeWorkItems,
  cautionKeyOf,
  effectiveItemKind,
  extractItemDate,
  resolveItemClient,
} from './invoice-match'
import { compareTotalWithExtras } from './invoice-extra'

export function yen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`
}

// 判定理由に出す立替経費の呼び名。実在のクライアント名と混ざらないよう固定の1語にまとめる。
export const EXPENSE_LABEL = '立替経費'

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

// 年またぎ（12月+1＝翌年1月、1月-1＝前年12月）は自前の加減算では扱えないため Date に任せる。
export function addMonths(base: InvoiceYearMonth, delta: number): InvoiceYearMonth {
  const d = new Date(base.year, base.month - 1 + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}

export function formatYearMonth(ym: InvoiceYearMonth): string {
  return `${ym.year}年${ym.month}月`
}

// マスタの支払開始月は date 列（'YYYY-MM-DD'）。日は使わないので年月だけ取り出す。
export function parseYearMonth(value: string): InvoiceYearMonth | null {
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
  target: InvoicePaymentTarget | null,
  payout: InvoiceYearMonth,
  confirmed: ReadonlySet<string>
): InvoicePaymentCountNote | null {
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
export function compareExpenses(
  expenseItems: InvoiceExtractedItem[],
  expenseTotal: number
): InvoiceCompared[] {
  if (expenseItems.length === 0) {
    // 経費が無い月まで指摘すると、立替の無い請求書が全件NGになってしまう。
    if (expenseTotal === 0) return []
    return [
      {
        verdict: 'ng',
        note: `${EXPENSE_LABEL}: 予定 ${yen(expenseTotal)} が請求書に見当たりません`,
        reason: { kind: 'expense_missing', expected: expenseTotal },
      },
    ]
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
        reason: { kind: 'expense_unregistered', billed },
      },
    ]
  }
  if (billed === expenseTotal) return [{ verdict: 'ok', note: `経費 ${yen(billed)} 一致` }]
  return [
    {
      verdict: 'ng',
      note: `経費　請求 ${yen(billed)}　登録 ${yen(expenseTotal)}（${yen(Math.abs(billed - expenseTotal))}相違）`,
      reason: { kind: 'expense_amount', billed, expected: expenseTotal },
    },
  ]
}

// 請求額と支払予定額の合計の突き合わせ。未決定・認めなかった追加費用は請求額から除いて比べる
// （理由は lib/invoice-extra の compareTotalWithExtras のコメント）。
// hintOf は差額に添える手がかり（明細の無い請求書で「何本分の差か」を示すもの）。不要なら空文字を返す。
export function compareInvoiceTotal(
  invoiceAmount: number | null,
  expectedAmount: number,
  extras: InvoiceExtraItem[],
  hintOf: (diff: number) => string
): InvoiceCompared {
  if (invoiceAmount === null) {
    return { verdict: 'hold', note: `請求額が読み取れないため金額を照合できません（支払予定 ${yen(expectedAmount)}）` }
  }
  const total = compareTotalWithExtras(invoiceAmount, expectedAmount, extras)
  const diff = total.billedWithoutExtras - expectedAmount
  if (total.matches) {
    return {
      verdict: 'ok',
      note:
        total.excluded > 0
          ? `支払予定 ${yen(expectedAmount)} と一致（追加費用 ${yen(total.excluded)} を除く）`
          : `支払予定 ${yen(expectedAmount)} と一致`,
    }
  }
  if (total.excluded > 0) {
    return {
      verdict: 'ng',
      note: `支払予定 ${yen(expectedAmount)} に対し、追加費用 ${yen(total.excluded)} を除いた請求 ${yen(total.billedWithoutExtras)}（差 ${yen(Math.abs(diff))} ${diff > 0 ? '多い' : '少ない'}）`,
      reason: { kind: 'total_without_extras', billed: total.billedWithoutExtras, expected: expectedAmount },
    }
  }
  return {
    verdict: 'ng',
    note: `支払予定 ${yen(expectedAmount)} に対し請求 ${yen(invoiceAmount)}（差 ${yen(Math.abs(diff))} ${diff > 0 ? '多い' : '少ない'}）${hintOf(diff)}`,
    reason: { kind: 'total', billed: invoiceAmount, expected: expectedAmount },
  }
}

// 明細の金額を全行読めているときだけ、明細の合計と請求額の整合を見る（読み取りミスの検出）。
// 1行でも読めていなければ差が出るのは当たり前で、指摘されても直しようがない。
// 追加費用の行も請求額の一部なので、合計には含めて数える。
function compareItemsSum(items: InvoiceExtractedItem[], invoiceAmount: number | null): InvoiceCompared[] {
  if (invoiceAmount === null || !items.every((item) => item.amount !== null)) return []
  const itemsTotal = items.reduce((sum, item) => sum + (item.amount ?? 0), 0)
  if (itemsTotal === invoiceAmount) return []
  return [
    {
      verdict: 'hold',
      note: `明細の合計（${yen(itemsTotal)}）と請求額（${yen(invoiceAmount)}）が一致しません（読み取りミスの可能性）`,
    },
  ]
}

// 業務明細のうち、支払いの相手（内訳の行・記録行）に1つに絞って帰属できなかったものの扱い。
// スキップ中・支払期間外・担当外のクライアント分なら、それぞれの理由を伝えて保留にする
// （「特定できません」だけだと、マスタの別名の登録漏れと誤解させるため）。
// 担当外（unassigned）の分は、支払いを記録する先の行が無く支払いが記録から漏れるため保留にし、
// 画面の「担当を追加」ボタンの行き先と一緒に unassignedNotes として返す（呼び出し側が保留として積む）。
// 支払回数の確認（countNotes）は、当てた先が分かる明細だけ相手の支払期間で確かめる。
function describeWorkAttribution<T extends InvoicePaymentTarget>(
  resolved: { item: InvoiceExtractedItem; indexes: number[] }[],
  targets: T[],
  skipped: InvoiceSkippedClient[],
  outOfPeriod: InvoiceOutOfPeriodClient[],
  unassigned: InvoiceUnassignedClient[],
  payout: InvoiceYearMonth,
  confirmedCautions: ReadonlySet<string>,
  contractor: { id: string; name: string }
): { results: InvoiceCompared[]; countNotes: InvoicePaymentCountNote[]; unassignedNotes: InvoiceUnassignedNote[] } {
  const results: InvoiceCompared[] = []
  const countNotes: InvoicePaymentCountNote[] = []
  const unassignedNotes: InvoiceUnassignedNote[] = []
  const addCountNote = (label: string, target: InvoicePaymentTarget | null) => {
    const note = checkPaymentCount(label, target, payout, confirmedCautions)
    if (note) countNotes.push(note)
  }
  const skippedNames = skipped.map((client) => client.matchNames)
  const outOfPeriodNames = outOfPeriod.map((client) => client.matchNames)
  const unassignedNames = unassigned.map((client) => client.matchNames)

  for (const { item, indexes } of resolved) {
    if (indexes.length === 0) {
      // 内訳に当たらなかった明細がスキップ中のクライアント分なら、「特定できません」ではなく
      // 「スキップ中のクライアントの分が載っている」と伝える（マスタの別名を疑わせないため）。
      const skippedHit = resolveItemClient(item, skippedNames).indexes
      if (skippedHit.length === 1) {
        const name = skipped[skippedHit[0]].clientName
        results.push({
          verdict: 'hold',
          note: `明細「${item.label}」は ${name} 分ですが、${name} は今月の支払いをスキップ中です（スキップを取り消すか、請求内容をご確認ください）`,
        })
        addCountNote(item.label, null)
        continue
      }
      // 支払期間の外（終了済み・開始前）のクライアント分なら、マスタに無いのではなく期間外だと伝える。
      const outOfPeriodHit = resolveItemClient(item, outOfPeriodNames).indexes
      if (outOfPeriodHit.length === 1) {
        const hit = outOfPeriod[outOfPeriodHit[0]]
        results.push({ verdict: 'hold', note: `明細「${item.label}」は ${hit.clientName} 分ですが、${hit.detail}` })
        addCountNote(item.label, null)
        continue
      }
      // 取引先マスタにはあるが、この委託者の担当（アサイン）に入っていないクライアント分なら、
      // 別名の登録漏れではなく担当の追加漏れだと伝える。
      const unassignedHit = resolveItemClient(item, unassignedNames).indexes
      if (unassignedHit.length === 1) {
        const hit = unassigned[unassignedHit[0]]
        unassignedNotes.push({
          note: `明細「${item.label}」は ${hit.clientName} 分ですが、${contractor.name}さんの担当のアサインに入っていません。担当を追加してください`,
          assignLink: { contractorId: contractor.id, clientId: hit.clientId },
        })
        addCountNote(item.label, null)
        continue
      }
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
        note: `明細「${item.label}」の候補が複数あります（${indexes.map((i) => targets[i].clientName).join(' / ')}）`,
      })
      addCountNote(item.label, null)
      continue
    }
    addCountNote(item.label, targets[indexes[0]])
  }
  return { results, countNotes, unassignedNotes }
}

// 請求書の明細行を、ツール側の内訳（アサイン別の支払予定）へ突き合わせる。
// 合計が一致していても内訳が入れ替わっていることがあるため、クライアント単位で本数・金額まで見る。
// 帰属の決め方は lib/invoice-match の resolveItemClient に集約している（AIが請求書全体から読んだ
// 取引先名を優先し、決まらなければ明細ラベルで照合する）。名前は表記ゆれ・通称が避けられないので
// 「文字列の中に呼び名があるか」まで緩め、1つに絞れない行は判定せず保留として人へ回す。
// 経費明細はクライアントの支払いではないため、ここでは経費どうしで別に照合する。
// 支払回数（「19/24」）の確認は判定（ok/ng/hold）とは別枠の countNotes として返す。明細と
// アサインの対応がここでしか分からない一方、status には影響させたくないため混ぜずに分ける。
// 代行者と、明細はあるが業務明細の無い編集者の請求書はこちらで判定する（編集者の業務明細は judgeEditorInvoiceByCap）。
export function compareInvoiceItems(
  items: InvoiceExtractedItem[],
  breakdown: InvoicePayoutBreakdownRow[],
  skipped: InvoiceSkippedClient[],
  outOfPeriod: InvoiceOutOfPeriodClient[],
  unassigned: InvoiceUnassignedClient[],
  expenseTotal: number,
  invoiceAmount: number | null,
  payout: InvoiceYearMonth,
  confirmedCautions: ReadonlySet<string>,
  contractor: { id: string; name: string }
): { results: InvoiceCompared[]; countNotes: InvoicePaymentCountNote[]; unassignedNotes: InvoiceUnassignedNote[] } {
  // 業務明細（work）の見分けと帰属は attributeWorkItems に任せる（手動OKの割り当て案と同じ結果を使うため）。
  // 追加費用（extra）はクライアント別の支払予定に相手がいないので、ここでは扱わず呼び出し側で別に見る。
  const expenseItems = items.filter((item) => effectiveItemKind(item) === 'expense')
  // 1クライアントを工程ごとに複数行へ分けて書く請求書があるため、突き合わせは
  // 「内訳1行 対 明細n行」で行い、合算してから比べる（1行ずつ比べると両方NGになる）。
  const attribution = attributeWorkItems(items, breakdown.map((target) => target.matchNames))
  const matchedItems = attribution.matched
  const described = describeWorkAttribution(
    attribution.resolved,
    breakdown,
    skipped,
    outOfPeriod,
    unassigned,
    payout,
    confirmedCautions,
    contractor
  )
  const results = described.results

  breakdown.forEach((target, index) => {
    const matched = matchedItems.get(index)
    if (!matched) {
      // 予定0円（納品予定なしの月）は請求書に出てこないのが正しい姿なので指摘しない。
      if (target.amount === 0) return
      results.push({
        verdict: 'ng',
        note: `${target.clientName}: 予定 ${yen(target.amount)} が請求書に見当たりません`,
        reason: { kind: 'client_missing', client: target.clientName, expected: target.amount },
      })
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
      // formatMismatchNote と同じ分かれ方にする（本数がズレていれば本数、そうでなければ金額）。
      // 片方だけ別の基準にすると、画面の判定理由と相手に送る文面が別のことを言ってしまう。
      reason:
        target.count !== null && billedCount !== null && countDiff !== null && countDiff !== 0
          ? { kind: 'client_count', client: target.clientName, billed: billedCount, expected: target.count }
          : { kind: 'client_amount', client: target.clientName, billed: billedAmount, expected: target.amount },
    })
  })

  results.push(...compareExpenses(expenseItems, expenseTotal))
  results.push(...compareItemsSum(items, invoiceAmount))

  return { results, countNotes: described.countNotes, unassignedNotes: described.unassignedNotes }
}

// ─── 編集者：請求書を正にして、合計本数だけ納品実績を上限にする ─────────────────
// 編集者は一部のクライアント分だけ請求する・クライアントの呼び名が違う・納品シートが未更新、などが日常的に起き、
// 「全アサインの納品実績＝支払予定」と完全一致を求めると、請求書が正しくてもNG・保留になってしまう。
// そこで支払額は請求書の明細（本数×単価）で決め、納品シートは「請求の合計本数が納品実績の合計を超えていないか」の
// 上限としてだけ使う。クライアント別の本数のずれや、請求書に載らなかったクライアントは指摘しない。

// 納品シートを読めなかった理由。タブが無いときは、年入り・年なしのどちらの名前でも探したことが分かる文言にする
// （年入りのタブだけ探したと誤解されると、年なしのタブを作り直すなど見当違いの直し方をさせてしまう）。
function capDeliveryHoldDetail(record: EditorCapRecord, deliveryMonth: InvoiceYearMonth): string {
  const delivery = record.delivery
  if (!delivery) return '納品チェックの結果を取得できませんでした'
  if (delivery.status === 'no_tab') {
    return `納品シートに「${deliveryMonth.year}年${deliveryMonth.month}月」（年入り）・「${deliveryMonth.month}月」（年なし）のどちらのタブも見つからないため、納品本数を確認できません`
  }
  return delivery.message ?? '納品チェックの結果を取得できませんでした'
}

// 明細1行の本数。本数が書かれていなければ、金額が単価で割り切れるときだけ本数に換算する
// （割り切れない金額から本数を出すと、端数を丸めた分だけ実在しない本数を作ってしまう）。
function itemCount(item: InvoiceExtractedItem, unitPrice: number): number | null {
  if (item.count !== null) return item.count
  if (item.amount === null || unitPrice <= 0 || item.amount % unitPrice !== 0) return null
  return item.amount / unitPrice
}

// 記録行の納品済み本数（合計の上限に足す数）。読めない行は null（上限には足さない）。
// 確定済みの行は人が決めた本数を使い、無ければ金額÷単価（割り切れるときだけ）で補う（従来の優先順位と同じ）。
function deliveredCountOf(record: EditorCapRecord, unitPrice: number): number | null {
  if (record.confirmed) {
    if (record.confirmed.count !== null) return record.confirmed.count
    if (unitPrice > 0 && record.confirmed.amount % unitPrice === 0) return record.confirmed.amount / unitPrice
    return null
  }
  if (!record.delivery || record.delivery.status !== 'ok') return null
  return record.delivery.delivered ?? 0
}

function strongestVerdict(verdicts: InvoiceVerdict[]): InvoiceVerdict {
  if (verdicts.includes('ng')) return 'ng'
  if (verdicts.includes('hold')) return 'hold'
  return 'ok'
}

export function judgeEditorInvoiceByCap(input: EditorCapJudgeInput): EditorCapJudgeResult {
  const { items, records, unitPrice } = input
  const results: InvoiceCompared[] = []
  const payouts: InvoiceDeliveryPayoutApply[] = []
  const sheetRevisions: { clientName: string; count: number }[] = []

  const attribution = attributeWorkItems(items, records.map((record) => record.matchNames))
  const described = describeWorkAttribution(
    attribution.resolved,
    records,
    input.skipped,
    input.outOfPeriod,
    input.unassigned,
    input.payout,
    input.confirmedCautions,
    input.contractor
  )
  results.push(...described.results)

  // 請求書に載ったクライアントの請求本数の合計と、その金額（支払予定額のもと）。
  let billedCountTotal = 0
  let workExpected = 0
  // 合計の上限を判定できるか（載ったクライアントすべてで請求本数と納品済み本数が分かっているか）。
  // 1社でも分からなければ、その社がすでに保留になっているので上限の判定は見送る（足りない数字で比べると誤ってNGになる）。
  let capKnown = true
  // 合計の突き合わせができるか（載ったクライアントすべてで金額が分かっているか）。
  let amountsKnown = true

  records.forEach((record, index) => {
    const matched = attribution.matched.get(index)
    // 請求書に載らなかったクライアントは何も出さない（一部のクライアント分だけ請求するのは正しい請求のため）。
    if (!matched) return
    const name = record.clientName
    const counts = matched.map((item) => itemCount(item, unitPrice))
    const billedCount = counts.every((c) => c !== null) ? counts.reduce((sum: number, c) => sum + (c ?? 0), 0) : null
    const billedAmount = matched.every((item) => item.amount !== null)
      ? matched.reduce((sum, item) => sum + (item.amount ?? 0), 0)
      : null

    if (billedCount === null && billedAmount === null) {
      results.push({ verdict: 'hold', note: `${name}: 明細の本数・金額が読み取れず照合できません` })
      capKnown = false
      amountsKnown = false
      return
    }
    if (billedAmount === null) {
      results.push({ verdict: 'hold', note: `${name}: 明細の金額が読み取れず照合できません（請求 ${billedCount}本）` })
      amountsKnown = false
    }

    if (record.confirmed) {
      // 実支払額が入っている行は人（またはこれまでの照合）が決めた額を尊重し、その額との一致だけを見る。
      // 書き戻しもしない（入っている値を請求書の値で上書きしない）。
      const confirmedAmount = record.confirmed.amount
      workExpected += confirmedAmount
      if (billedAmount !== null) {
        if (billedAmount === confirmedAmount) {
          results.push({ verdict: 'ok', note: `${name}　確定済みの支払額 ${yen(confirmedAmount)} と一致` })
        } else {
          results.push({
            verdict: 'ng',
            note: `${name}　請求 ${yen(billedAmount)}　確定済みの支払額 ${yen(confirmedAmount)}（${yen(Math.abs(billedAmount - confirmedAmount))}相違）`,
            reason: { kind: 'client_amount', client: name, billed: billedAmount, expected: confirmedAmount },
          })
        }
      }
      // 確定済みの行は本数が書かれていなくても額で確かめられているので、上限には確定済みの本数を使う。
      const counted = billedCount ?? deliveredCountOf(record, unitPrice)
      if (counted === null) capKnown = false
      else billedCountTotal += counted
      return
    }

    if (unitPrice <= 0) {
      results.push({ verdict: 'hold', note: `${name}: 編集者の単価が未設定のため、請求の金額を確認できません` })
      capKnown = false
      amountsKnown = false
      return
    }
    if (billedCount === null) {
      results.push({
        verdict: 'hold',
        note: `${name}: 明細の本数が読み取れず、金額 ${yen(billedAmount ?? 0)} が単価 ${yen(unitPrice)} で割り切れないため本数を確認できません`,
      })
      capKnown = false
      amountsKnown = false
      return
    }
    billedCountTotal += billedCount
    const expectedAmount = billedCount * unitPrice
    workExpected += expectedAmount

    // 納品シートが読めないクライアントは、0本とみなさず保留にする（シートの設定を直せば確かめられるため）。
    // 「納品が揃っていない」は保留にしない。納品済みの本数をそのまま上限に使う。
    const readable = record.delivery !== null && record.delivery.status === 'ok'
    if (!readable) {
      results.push({ verdict: 'hold', note: `${name}: ${capDeliveryHoldDetail(record, input.deliveryMonth)}` })
      capKnown = false
    } else if ((record.delivery?.revisions ?? 0) > 0) {
      sheetRevisions.push({ clientName: name, count: record.delivery?.revisions ?? 0 })
    }

    if (billedAmount === null) return
    if (billedAmount !== expectedAmount) {
      results.push({
        verdict: 'ng',
        note: `${name}　請求 ${billedCount}本 ${yen(billedAmount)}　本数×単価 ${yen(expectedAmount)}（${yen(Math.abs(billedAmount - expectedAmount))}相違）`,
        reason: { kind: 'client_amount', client: name, billed: billedAmount, expected: expectedAmount },
      })
      return
    }
    results.push({ verdict: 'ok', note: `${name}　請求 ${billedCount}本 ${yen(billedAmount)}（本数×単価と一致）` })
    // 納品を確かめられなかった行は書き戻さない（保留なのでOKにはならないが、書き込む根拠が無い行を混ぜないため）。
    if (readable) payouts.push({ recordId: record.recordId, amount: billedAmount, videoCount: billedCount })
  })

  // ─── 合計本数の上限 ─────────────────────────────
  // 上限はこの委託者の全記録行の納品済み本数の合計（請求書に載らなかったクライアント分も含む。読めた分だけ足す）。
  // 呼び名の違いでクライアント別に食い違って見えても、合計が実績内なら過払いにはならないため、合計だけで見る。
  if (attribution.matched.size > 0 && capKnown) {
    const deliveredTotal = records.reduce((sum, record) => sum + (deliveredCountOf(record, unitPrice) ?? 0), 0)
    if (billedCountTotal > deliveredTotal) {
      const over = billedCountTotal - deliveredTotal
      results.push({
        verdict: 'ng',
        note: `請求 ${billedCountTotal}本　納品実績 ${deliveredTotal}本（${over}本超過）`,
        reason: { kind: 'total_count_over', billed: billedCountTotal, delivered: deliveredTotal, over },
      })
    } else {
      results.push({ verdict: 'ok', note: `請求 ${billedCountTotal}本　納品実績 ${deliveredTotal}本（上限内）` })
    }
  }

  const expenseItems = items.filter((item) => effectiveItemKind(item) === 'expense')
  results.push(...compareExpenses(expenseItems, input.expenseTotal))

  // 支払予定額＝請求書に載ったクライアントの金額（本数×単価・確定済みの額）＋立替経費＋認め済みの追加費用。
  const expectedAmount = workExpected + input.expenseTotal + input.approvedExtraTotal
  // 帰属できなかった明細・金額の分からない明細があるときは、それぞれ保留がすでに出ているので
  // 合計の突き合わせはしない（同じ原因で合計の不一致まで指摘すると二重になる）。
  // 請求額が読めないことだけは、他の保留とは別の問題として残す。
  if (input.invoiceAmount === null) {
    results.push(compareInvoiceTotal(null, expectedAmount, input.extraItems, () => ''))
  } else if (attribution.unassigned.length === 0 && amountsKnown) {
    results.push(compareInvoiceTotal(input.invoiceAmount, expectedAmount, input.extraItems, () => ''))
  }
  results.push(...compareItemsSum(items, input.invoiceAmount))

  // 追加費用は、未決定なら人の判断待ち（保留）・認めなかったらNG（呼び出し側が理由を積む。ここでは結論にだけ含める）。
  const extraVerdicts: InvoiceVerdict[] = input.extraItems.map((extra) =>
    extra.decision === 'rejected' ? 'ng' : extra.decision === 'pending' ? 'hold' : 'ok'
  )
  const verdict = strongestVerdict([
    ...results.map((r) => r.verdict),
    ...described.unassignedNotes.map((): InvoiceVerdict => 'hold'),
    ...extraVerdicts,
  ])

  return {
    verdict,
    results,
    countNotes: described.countNotes,
    unassignedNotes: described.unassignedNotes,
    // 書き戻しは金額まわりがOKのときだけ指示する（NG・保留の請求書の数字を支払額に入れないため）。
    // 呼び出し側も最終的な判定がOKのときしか書かないが、判定だけを見る人にも誤解の無い形で返す。
    payouts: verdict === 'ok' ? payouts : [],
    expectedAmount,
    sheetRevisions,
  }
}
