import { db } from './db'
import { assignments, clientBillingItems, monthlyRecords, monthlyClientRecords, monthlyGlobalTasks, payrollRecipients, monthlyPayrollRecords, payrollRecurringReimbursements, payrollReimbursementItems } from './schema'
import { and, eq } from 'drizzle-orm'

// 支払期間（開始月・回数）から、その (year, month) が支払い対象かを判定する。
// 生成側と、期間外になった月次レコードの掃除側（app/api/master/assignments/[id]）で
// 同じ判定を使うため export している。片方だけ直すと生成と掃除が食い違うため実装は必ずここ1か所に置く。
export function isPaymentActiveForMonth(
  assignment: { payment_start_month: string | null; payment_count: number | null },
  year: number,
  month: number,
): boolean {
  if (!assignment.payment_start_month) return true
  const [startYear, startMonth] = assignment.payment_start_month.split('-').map(Number)
  const index = (year - startYear) * 12 + (month - startMonth)
  if (index < 0) return false
  return assignment.payment_count == null || index < assignment.payment_count
}

// 契約開始月・契約期間から、その (year, month) に内訳が有効かを判定する。
// contract_start が無ければ常に有効。contract_months が無ければ開始月以降ずっと有効。
function isBillingItemActiveForMonth(
  item: { contract_start: string | null; contract_months: number | null },
  year: number,
  month: number
): boolean {
  if (!item.contract_start) return true
  const [startYearStr, startMonthStr] = item.contract_start.split('-')
  const startYear = Number(startYearStr)
  const startMonth = Number(startMonthStr)
  const idx = year * 12 + month - (startYear * 12 + startMonth)
  if (idx < 0) return false
  if (item.contract_months == null) return true
  return idx < item.contract_months
}

export async function generateMonthlyRecords(year: number, month: number) {
  const activeAssignments = await db.select({
    id: assignments.id,
    contractor_payout_amount: assignments.contractor_payout_amount,
    payment_start_month: assignments.payment_start_month,
    payment_count: assignments.payment_count,
  }).from(assignments).where(eq(assignments.active, true))

  const payableAssignments = activeAssignments.filter((a) => isPaymentActiveForMonth(a, year, month))

  if (payableAssignments.length > 0) {
    await db.insert(monthlyRecords)
      .values(payableAssignments.map((a) => ({
        year,
        month,
        assignment_id: a.id,
        payout_amount_snapshot: a.contractor_payout_amount,
      })))
      .onConflictDoNothing()
  }

  // クライアント請求は「内訳（client_billing_items）」単位で生成する。
  // active かつ その月に契約が有効な内訳だけを対象にする。
  const allItems = await db.select({
    id: clientBillingItems.id,
    client_id: clientBillingItems.client_id,
    label: clientBillingItems.label,
    billing_amount: clientBillingItems.billing_amount,
    active: clientBillingItems.active,
    contract_start: clientBillingItems.contract_start,
    contract_months: clientBillingItems.contract_months,
  }).from(clientBillingItems)

  const activeItems = allItems.filter((it) => it.active && isBillingItemActiveForMonth(it, year, month))

  if (activeItems.length > 0) {
    await db.insert(monthlyClientRecords)
      .values(activeItems.map((it) => ({
        year,
        month,
        client_id: it.client_id,
        billing_item_id: it.id,
        billing_amount_snapshot: it.billing_amount,
        label_snapshot: it.label,
      })))
      .onConflictDoNothing()
  }

  // 役員報酬・給与。契約期間の概念が無い（在籍している限り毎月発生する）ため、
  // active な対象者をそのまま全員生成する。
  const activeRecipients = await db.select().from(payrollRecipients).where(eq(payrollRecipients.active, true))

  if (activeRecipients.length > 0) {
    await db.insert(monthlyPayrollRecords)
      .values(activeRecipients.map((p) => ({
        year,
        month,
        recipient_id: p.id,
        gross_snapshot: p.gross_amount,
        health_insurance_snapshot: p.health_insurance,
        pension_snapshot: p.pension,
        employment_insurance_snapshot: p.employment_insurance,
        income_tax_snapshot: p.income_tax,
        resident_tax_snapshot: p.resident_tax,
      })))
      .onConflictDoNothing()
  }

  await db.insert(monthlyGlobalTasks)
    .values({ year, month })
    .onConflictDoNothing()

  // 毎月の定額立替。役員報酬と同じく「在籍している限り毎月発生する」ものだが、
  // 開始月より前の月には作らない（登録した瞬間に過去の月まで振込額が増えると事故になるため）。
  // 対象者が active=false（＝在籍していない）なら生成しない。退職・辞任した人に返す立替は発生せず、
  // 気付かないまま毎月の振込額に積み上がる方が危ないため、対象者の在籍を生成の前提条件にする。
  //
  // ここを最後に置くのは、後から足した生成が既存の生成（支払い・請求・給与・月次タスク）を
  // 巻き添えにしないため。このブロックで例外が出ても、上の4つはすでに書き込み済みで残る。
  const activeRecurring = await db
    .select({
      id: payrollRecurringReimbursements.id,
      recipient_id: payrollRecurringReimbursements.recipient_id,
      description: payrollRecurringReimbursements.description,
      amount: payrollRecurringReimbursements.amount,
      start_year: payrollRecurringReimbursements.start_year,
      start_month: payrollRecurringReimbursements.start_month,
    })
    .from(payrollRecurringReimbursements)
    .innerJoin(payrollRecipients, eq(payrollRecurringReimbursements.recipient_id, payrollRecipients.id))
    .where(and(eq(payrollRecurringReimbursements.active, true), eq(payrollRecipients.active, true)))

  // 年月の大小は「年×12＋月」の通し番号にして比べる（年をまたぐ比較を場合分けせずに済む）。
  const targetIndex = year * 12 + month
  const dueRecurring = activeRecurring.filter((r) => r.start_year * 12 + r.start_month <= targetIndex)

  if (dueRecurring.length > 0) {
    // item_date（実際に立て替えた日）は定額設定には無いので null。日付が要る立替は手入力の行で足す。
    // 二重生成は (recurring_id, year, month) の一意制約が止めるので、ここは何度呼ばれても増えない。
    await db.insert(payrollReimbursementItems)
      .values(dueRecurring.map((r) => ({
        recipient_id: r.recipient_id,
        year,
        month,
        item_date: null,
        description: r.description,
        amount: r.amount,
        recurring_id: r.id,
      })))
      .onConflictDoNothing()
  }

  return {
    assignmentCount: payableAssignments.length,
    clientCount: activeItems.length,
    payrollCount: activeRecipients.length,
    recurringReimbursementCount: dueRecurring.length,
  }
}
