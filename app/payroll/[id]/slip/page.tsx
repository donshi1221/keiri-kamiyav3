import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { monthlyPayrollRecords, payrollReimbursementItems } from '@/lib/schema'
import { and, asc, eq } from 'drizzle-orm'
import { getLastDayOfMonth } from '@/lib/dates'
import { COMPANY_NAME, PAYROLL_DEFAULT_PAY_DAY } from '@/lib/config'
import {
  PAYROLL_KIND_LABEL,
  payrollAmountsOfRecord,
  payrollDeductions,
  payrollReimbursementTotal,
  payrollTransferAmount,
} from '@/lib/payroll'
import PrintButton from './print-button'

// 金額は月次の控え（snapshot）を毎回DBから読む。
// 金額修正の直後に古い明細が刷られると本人へ渡す紙が間違うため、静的化しない。
export const dynamic = 'force-dynamic'

const yen = (n: number) => `¥${n.toLocaleString()}`

// 明細の1行。0円の項目を出すかどうかは呼び出し側で決める（役員は雇用保険が無いなど）。
function Row({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border px-3 py-2 text-sm last:border-b-0">
      <span className="text-foreground">
        {label}
        {note && <span className="ml-1 text-xs text-muted-foreground">{note}</span>}
      </span>
      <span className="font-semibold text-foreground">{yen(value)}</span>
    </div>
  )
}

function TotalRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border bg-secondary px-3 py-2 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      <span className="font-bold text-foreground">{yen(value)}</span>
    </div>
  )
}

export default async function PayrollSlipPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const record = await db.query.monthlyPayrollRecords.findFirst({
    where: eq(monthlyPayrollRecords.id, id),
    with: { payroll_recipients: { columns: { name: true, kind: true, pay_day: true } } },
  })
  if (!record) notFound()

  // 立替は月次レコードではなく (対象者, 年, 月) にぶら下がるので、レコードとは別に読む。
  const reimbursements = await db
    .select()
    .from(payrollReimbursementItems)
    .where(
      and(
        eq(payrollReimbursementItems.recipient_id, record.recipient_id),
        eq(payrollReimbursementItems.year, record.year),
        eq(payrollReimbursementItems.month, record.month)
      )
    )
    .orderBy(asc(payrollReimbursementItems.created_at))
  const reimbursementTotal = payrollReimbursementTotal(reimbursements)

  const amounts = payrollAmountsOfRecord(record)
  const kind = record.payroll_recipients?.kind ?? 'employee'
  const isExecutive = kind === 'executive'
  // 役員報酬は「給与明細書」と呼ばないため、表題も支給項目名も区分で言い換える。
  const title = `${record.year}年${record.month}月分 ${isExecutive ? '役員報酬明細書' : '給与明細書'}`
  // 支払日は月末を超える指定を末日に丸める（ダッシュボード・リマインドと同じ扱い）。
  const payDay = Math.min(
    record.payroll_recipients?.pay_day ?? PAYROLL_DEFAULT_PAY_DAY,
    getLastDayOfMonth(record.year, record.month)
  )

  const gross = amounts.gross + reimbursementTotal
  const deductions = payrollDeductions(amounts)
  const transfer = payrollTransferAmount(amounts, reimbursementTotal)

  return (
    <div className="mx-auto w-full max-w-[210mm] space-y-4 print:max-w-none">
      {/* 画面用の操作。紙には残さない。 */}
      <div data-print-hide className="flex justify-end">
        <PrintButton />
      </div>

      <div className="rounded-lg border border-border bg-card p-6 print:rounded-none print:border-0 print:p-0">
        <header className="mb-6">
          <h1 className="text-center text-lg font-bold text-foreground">{title}</h1>
          {/* 社名は環境変数で差し替える運用。空にした場合は行ごと出さない。 */}
          {COMPANY_NAME && (
            <p className="mt-4 text-right text-sm text-muted-foreground">{COMPANY_NAME}</p>
          )}
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">氏名</dt>
              <dd className="font-medium text-foreground">{record.payroll_recipients?.name ?? '—'} 様</dd>
            </div>
            <div className="flex gap-2 sm:justify-end">
              <dt className="text-muted-foreground">支払日</dt>
              <dd className="font-medium text-foreground">{record.year}年{record.month}月{payDay}日</dd>
            </div>
          </dl>
        </header>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <section className="rounded border border-border">
            <h2 className="border-b border-border bg-secondary px-3 py-2 text-sm font-semibold text-foreground">支給</h2>
            <Row label={isExecutive ? '役員報酬' : '基本給'} value={amounts.gross} />
            {reimbursementTotal > 0 && (
              <Row label="立替経費精算" note="（非課税）" value={reimbursementTotal} />
            )}
            <TotalRow label="支給合計" value={gross} />
          </section>

          <section className="rounded border border-border">
            <h2 className="border-b border-border bg-secondary px-3 py-2 text-sm font-semibold text-foreground">控除</h2>
            <Row label="健康保険料" value={amounts.health_insurance} />
            <Row label="厚生年金保険料" value={amounts.pension} />
            {/* 役員は雇用保険の対象外で常に0円になるため、0の月は行ごと出さない。 */}
            {amounts.employment_insurance > 0 && (
              <Row label="雇用保険料" value={amounts.employment_insurance} />
            )}
            <Row label="源泉所得税" value={amounts.income_tax} />
            <Row label="住民税" value={amounts.resident_tax} />
            <TotalRow label="控除合計" value={deductions} />
          </section>
        </div>

        {/* 立替経費の内訳。合計だけを渡すと本人が「何の分か」を確かめられず、
            違算の問い合わせが必ず経理に戻ってくるため、明細をそのまま紙に載せる。
            立替が無い月は行ごと出さない（従来どおり）。 */}
        {reimbursements.length > 0 && (
          <section className="mt-4 rounded border border-border">
            <h2 className="border-b border-border bg-secondary px-3 py-2 text-sm font-semibold text-foreground">
              立替経費精算の内訳<span className="ml-1 text-xs font-normal text-muted-foreground">（非課税）</span>
            </h2>
            {/* 幅の狭い端末でも項目名を潰さずに読めるよう、表そのものを横スクロールさせる。 */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[20rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="w-[7rem] px-3 py-1.5 text-left font-medium">利用日</th>
                    <th className="px-3 py-1.5 text-left font-medium">項目</th>
                    <th className="w-[7rem] px-3 py-1.5 text-right font-medium">金額</th>
                  </tr>
                </thead>
                <tbody>
                  {reimbursements.map((item) => (
                    <tr key={item.id} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">{item.item_date ?? '—'}</td>
                      <td className="px-3 py-1.5 break-words text-foreground">{item.description}</td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap text-foreground">{yen(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TotalRow label="立替経費精算 合計" value={reimbursementTotal} />
          </section>
        )}

        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 rounded border border-border bg-secondary px-4 py-3">
          <span className="text-sm font-semibold text-foreground">差引支給額（振込額）</span>
          <span className="text-2xl font-bold text-foreground">{yen(transfer)}</span>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          {PAYROLL_KIND_LABEL[kind]}の明細です。金額に相違がある場合は経理までご連絡ください。
        </p>
      </div>
    </div>
  )
}
