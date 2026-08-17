import type { MonthlyPayrollRecord, PayrollRecipient } from './schema'
import type { PayrollAmounts, PayrollKind } from './ui-types'

// 役員報酬・給与の金額計算を1か所に集める。
// 画面（ダッシュボード・マスタ管理）とリマインドメールが別々に引き算を書くと、
// 片方だけ控除項目を足し忘れて「画面と振込リマインドの金額が違う」事故になるため。

// マスタの登録値を計算用の形へ寄せる。
export function payrollAmountsOfRecipient(r: Pick<
  PayrollRecipient,
  'gross_amount' | 'health_insurance' | 'pension' | 'employment_insurance' | 'income_tax' | 'resident_tax'
>): PayrollAmounts {
  return {
    gross: r.gross_amount,
    health_insurance: r.health_insurance,
    pension: r.pension,
    employment_insurance: r.employment_insurance,
    income_tax: r.income_tax,
    resident_tax: r.resident_tax,
  }
}

// 月次の控え（snapshot）を計算用の形へ寄せる。
export function payrollAmountsOfRecord(r: Pick<
  MonthlyPayrollRecord,
  | 'gross_snapshot'
  | 'health_insurance_snapshot'
  | 'pension_snapshot'
  | 'employment_insurance_snapshot'
  | 'income_tax_snapshot'
  | 'resident_tax_snapshot'
>): PayrollAmounts {
  return {
    gross: r.gross_snapshot,
    health_insurance: r.health_insurance_snapshot,
    pension: r.pension_snapshot,
    employment_insurance: r.employment_insurance_snapshot,
    income_tax: r.income_tax_snapshot,
    resident_tax: r.resident_tax_snapshot,
  }
}

// 控除の合計（本人負担分）。
export function payrollDeductions(a: PayrollAmounts): number {
  return a.health_insurance + a.pension + a.employment_insurance + a.income_tax + a.resident_tax
}

// 振込額（手取り）＝ 額面 − 控除の合計。
// 控除が額面を上回る登録ミスがあっても負数のまま返す（0に丸めると誤りが画面から見えなくなる）。
export function payrollNet(a: PayrollAmounts): number {
  return a.gross - payrollDeductions(a)
}

// 実際に振り込む金額 ＝ 手取り + 立替経費の精算。
// 立替の精算は非課税の実費返金なので payrollNet（控除の引き算）には通さず、
// 手取りが確定したあとにここで足す（詳しい理由は lib/schema の expense_reimbursement のコメント）。
// 画面・明細・リマインドが同じ足し算を各所に書くと片方だけ足し忘れるため、この1本に寄せる。
export function payrollTransferAmount(a: PayrollAmounts, expenseReimbursement: number): number {
  return payrollNet(a) + expenseReimbursement
}

export const PAYROLL_KIND_LABEL: Record<PayrollKind, string> = {
  executive: '役員報酬',
  employee: '給与',
}
