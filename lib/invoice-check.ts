import 'server-only'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { assignments, contractors, expenses, invoiceUploads, monthlyRecords } from '@/lib/schema'
import { checkAssignmentDelivery } from '@/lib/sheets'
import { deliveryTargetMonth, deliveryTone, suggestedPayout } from '@/lib/delivery-status'
import { COMPANY_NAME } from '@/lib/config'
import { nowJST } from '@/lib/dates'
import { INVOICE_MANUAL_EDIT_NOTE, formatInvoiceNote, hasInvoiceNoteMark } from '@/lib/invoice-notes'
import type { DeliveryCheckRow, InvoiceCheckOutcome, InvoiceCheckResult, InvoiceCheckStatus } from '@/lib/ui-types'

// 3観点（差出人・対象月＋金額・宛名）それぞれの結論。
// - ok   : 一致した
// - ng   : 不一致（人が中身を直す必要がある）
// - hold : 判定材料が足りず結論を出せない（マスタ登録漏れ・納品未反映など）
type Verdict = 'ok' | 'ng' | 'hold'

// 名前の比較は表記ゆれで落ちやすい。空白（半角・全角）は意味を持たないので除去してから比べる。
// 「株式会社」等の法人格は略さずそのまま扱う（略すと別法人まで一致してしまうため）。
function normalizeName(value: string): string {
  return value.replace(/[\s　]/g, '')
}

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
// notes は算出の途中で人に伝えたい補足（納品予定0件の月など）。金額だけでは
// 「なぜその予定額になったのか」が追えないため、判定理由に混ぜて残す。
type ExpectedOutcome = { amount: number; notes: string[] } | { hold: string }

// 対象月に「その委託者へいくら払う予定か」を算出する。
// 代行者は契約額（当月の控えを優先）、編集者は納品チェックで反映済みの実支払額を正とし、
// 未反映なら納品シートをその場で読んで補う。立替経費は同額を支払いに乗せるため合算する。
// ダッシュボードの支払予定額（recordPayout）と同じ定義に揃えてある（食い違うと照合が信用できなくなる）。
async function computeExpectedPayout(
  contractor: ContractorRow,
  year: number,
  month: number
): Promise<ExpectedOutcome> {
  const assignmentRows = await db.query.assignments.findMany({
    where: (a, { and: andOp, eq: eqOp }) => andOp(eqOp(a.contractor_id, contractor.id), eqOp(a.active, true)),
    with: { clients: { columns: { name: true } } },
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
    return { hold: `${year}年${month}月分の月次レコードがありません` }
  }

  const isVideoEditor = contractor.contractor_type === 'video_editor'
  // 編集者の支払いは前月の納品に対して行うため、読むべき納品シートの月は1つ手前になる。
  const deliveryMonth = deliveryTargetMonth(year, month).month
  let total = 0
  const notes: string[] = []

  for (const record of records) {
    const assignment = assignmentRows.find((a) => a.id === record.assignment_id)
    if (!assignment) continue
    const clientName = assignment.clients?.name ?? '?'

    if (!isVideoEditor) {
      total += record.payout_amount_snapshot ?? assignment.contractor_payout_amount
      continue
    }
    if (record.actual_payout_amount !== null) {
      total += record.actual_payout_amount
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
        continue
      }
      return {
        hold: `納品チェックが未反映のため金額を確定できません（${clientName}: ${deliveryHoldDetail(delivery, contractor.unit_price)}）`,
      }
    }
    total += suggested
  }

  const expenseRows = await db
    .select({ amount: expenses.amount })
    .from(expenses)
    .where(and(inArray(expenses.assignment_id, assignmentIds), eq(expenses.year, year), eq(expenses.month, month)))
  total += expenseRows.reduce((sum, e) => sum + e.amount, 0)

  return { amount: total, notes }
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
      extract_error: invoiceUploads.extract_error,
      check_notes: invoiceUploads.check_notes,
    })
    .from(invoiceUploads)
    .where(eq(invoiceUploads.id, id))
  if (!row) return null

  // 読み取れていない請求書は判定材料が無い。ここで hold にすると「照合した結果の保留」と区別できず、
  // 先に再読み取りが必要であることが伝わらないため、status は pending のまま触らない。
  if (row.extract_error) {
    return { skipped: 'AIの読み取りに失敗しているため照合できません。先に再読み取りを行ってください。' }
  }

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
  if (row.extracted_month === null) {
    record('hold', '対象月が読み取れません')
  } else {
    resolvedMonth = row.extracted_month
    resolvedYear = resolveYear(row.extracted_month, row.extracted_year)
    record('ok', `対象月は ${resolvedYear}年${resolvedMonth}月分 として照合しました`)
  }

  // ─── C. 金額の照合 ─────────────────────────────────────────
  let expectedAmount: number | null = null
  if (contractor && resolvedYear !== null && resolvedMonth !== null) {
    const expected = await computeExpectedPayout(contractor, resolvedYear, resolvedMonth)
    if ('hold' in expected) {
      record('hold', expected.hold)
    } else {
      expectedAmount = expected.amount
      for (const note of expected.notes) record('ok', note)
      if (row.extracted_amount === null) {
        record('hold', `請求額が読み取れないため金額を照合できません（支払予定 ${yen(expectedAmount)}）`)
      } else if (row.extracted_amount === expectedAmount) {
        record('ok', `支払予定 ${yen(expectedAmount)} と一致`)
      } else {
        const diff = row.extracted_amount - expectedAmount
        record(
          'ng',
          `支払予定 ${yen(expectedAmount)} に対し請求 ${yen(row.extracted_amount)}（差 ${yen(Math.abs(diff))} ${diff > 0 ? '多い' : '少ない'}）`
        )
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
  if (status === 'ok' && contractor && resolvedYear !== null && resolvedMonth !== null) {
    const received = await markInvoiceReceived(contractor.id, resolvedYear, resolvedMonth)
    if (received.marked > 0) {
      notes.push(formatInvoiceNote('received', `請求書受領チェックを自動で付けました（${received.marked}件）`))
    } else if (received.total > 0) {
      notes.push(
        formatInvoiceNote('received', '受領チェックは既に付いていました（別の請求書で受領済みの可能性があります）')
      )
    }
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
    })
    .where(eq(invoiceUploads.id, id))

  return result
}
