import { EXPENSE_AMOUNT_CHECK_TOLERANCE_YEN, EXPENSE_TAX_RATES } from '@/lib/config'
import { formatExpenseAmount } from '@/app/components/expense-format'
import type { ExpenseAmountCheckInput } from '@/lib/ui-types'

const READ_ERROR_HINT = '手書きの数字の読み違いの可能性があります。'

function withinTolerance(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= EXPENSE_AMOUNT_CHECK_TOLERANCE_YEN
}

// 消費税額が、元の金額（税抜）のどれかの税率ぶんになっているか。端数処理の差は許容差で吸収する。
function taxMatchesRate(tax: number, base: number): boolean {
  return EXPENSE_TAX_RATES.some((rate) => withinTolerance(tax, base * rate))
}

const RATE_LABEL = EXPENSE_TAX_RATES.map((rate) => `${Math.round(rate * 100)}%`).join('・')

// AIが読んだ合計（amount）を、領収証の内訳欄の数字で検算する。合えば null、合わなければ人向けの警告文。
// 手書きの「¥」を「7」と読み違える事故（¥9,900 → 79,900）が指示文の改善だけでは止まらなかったため、
// AIの答えをAI自身に検算させるのでなく、コード側で確かめる。
// 確かめるのは2つ:
//   1. 合計 ＝ 内訳の足し算になっているか
//   2. 消費税が内訳の金額の 8%・10% になっているか（「¥」の読み違いが合計と税抜の両方に起きると、
//      1 の足し算は合ってしまう。実例: 79,000 ＋ 900 ＝ 79,900）
// DB・外部通信に触れないのは、受付・確認画面と同じ判定を単体でも確かめられるようにするため。
export function checkExpenseAmount(input: ExpenseAmountCheckInput): string | null {
  const { amount, breakdown_amount, breakdown_tax, breakdown_is_tax_included } = input
  // 内訳の金額と消費税の片方しか読めていないと、どちらの検算も根拠を持てない。
  // そこで警告を出すと内訳の無い書類まで疑うことになるため、検算そのものをしない。
  if (breakdown_amount === null || breakdown_tax === null) return null

  const excludedTotal = breakdown_amount + breakdown_tax
  const reasons: string[] = []

  // 税込・税抜の丸囲みが判別できない（null）ときは、どちらの読み方でも合えば合格にする。
  // 片方に決め打ちすると、正しく読めた領収証にまで警告が出てしまうため。
  const sumOk =
    breakdown_is_tax_included === true
      ? withinTolerance(amount, breakdown_amount)
      : withinTolerance(amount, excludedTotal) ||
        (breakdown_is_tax_included === null && withinTolerance(amount, breakdown_amount))
  if (!sumOk) {
    reasons.push(
      breakdown_is_tax_included === true
        ? `合計 ${formatExpenseAmount(amount)} と、内訳（税込 ${formatExpenseAmount(breakdown_amount)}）が合いません。`
        : `合計 ${formatExpenseAmount(amount)} と、内訳（税抜 ${formatExpenseAmount(breakdown_amount)} ＋ 消費税 ` +
            `${formatExpenseAmount(breakdown_tax)} ＝ ${formatExpenseAmount(excludedTotal)}）が合いません。`
    )
  }

  // 税率の基準は税抜の金額。税込の内訳なら消費税を引いて税抜に戻す。不明ならどちらかで合えば合格。
  const taxIncludedBase = breakdown_amount - breakdown_tax
  const rateOk =
    breakdown_is_tax_included === true
      ? taxMatchesRate(breakdown_tax, taxIncludedBase)
      : taxMatchesRate(breakdown_tax, breakdown_amount) ||
        (breakdown_is_tax_included === null && taxMatchesRate(breakdown_tax, taxIncludedBase))
  if (!rateOk) {
    const base = breakdown_is_tax_included === true ? taxIncludedBase : breakdown_amount
    const baseLabel = breakdown_is_tax_included === true ? '内訳の税抜相当の金額' : '内訳の金額'
    reasons.push(
      `消費税 ${formatExpenseAmount(breakdown_tax)} が、${baseLabel} ${formatExpenseAmount(base)} の${RATE_LABEL} になっていません。`
    )
  }

  // 理由が2つあっても警告は1つの文字列にまとめる（画面・メールで1行ぶんとして扱えるように）。
  return reasons.length === 0 ? null : reasons.join('また、') + READ_ERROR_HINT
}
