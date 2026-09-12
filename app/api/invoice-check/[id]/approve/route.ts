import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { contractors, invoiceUploads, monthlyRecords } from '@/lib/schema'
import { checkInvoiceAndSave, findPayoutMonthlyRecords, payoutMonthOf } from '@/lib/invoice-check'
import { parseBody, invoiceManualApproveSchema } from '@/lib/validation'
import { eq } from 'drizzle-orm'

// 実支払額を入れた後に照合をやり直す。同じ委託者の他のアサインで納品シート（外部）を
// 読みにいくことがあるため、recheck 側と同じ理由で既定より長い実行時間を許可する。
export const maxDuration = 60

// 保留の手動OK。保留の多くは納品シートを読めない・本数が揃わないことが原因で、
// 金額そのものは人が納品状況を見て確認できていることが多い。
// 月次レコードに実支払額が入っている行は納品シート照合を飛ばす仕組み（lib/invoice-check の
// computeExpectedPayout）が既にあるため、その値を人が入れる口をここに用意する。
// ダッシュボードでの手入力と同じ列・同じ意味に書き込むので、後続の集計は経路によらず変わらない。
export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]/approve'>
) {
  try {
    const { id } = await ctx.params
    const parsed = parseBody(invoiceManualApproveSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })

    const [invoice] = await db
      .select({
        status: invoiceUploads.status,
        contractor_id: invoiceUploads.contractor_id,
        resolved_year: invoiceUploads.resolved_year,
        resolved_month: invoiceUploads.resolved_month,
      })
      .from(invoiceUploads)
      .where(eq(invoiceUploads.id, id))
    if (!invoice) return Response.json({ error: 'Not found' }, { status: 404 })

    // OK・pendingの行にこの操作を許すと、判定が合っていないのに金額だけ確定してしまう。
    // 対象は「材料が足りずに結論が出せなかった」保留の行と、
    // 「編集者のイレギュラー請求で実支払額を優先すれば直る」NGの行に限る。
    if (invoice.status !== 'hold' && invoice.status !== 'ng') {
      return Response.json({ error: '保留またはNGの請求書だけが手動OKの対象です' }, { status: 400 })
    }
    // NGの行は、期待額の計算で actual_payout_amount を優先するのが編集者（video_editor）だけ。
    // 代行者（daiko）は契約額・snapshotで計算するため、ここで金額を入れても判定は直らず、
    // 押した人が「入れたのに直らない」と混乱する事故になる。保留(hold)は種別を問わず従来どおり許可する。
    if (invoice.status === 'ng' && invoice.contractor_id) {
      const [contractor] = await db
        .select({ contractor_type: contractors.contractor_type })
        .from(contractors)
        .where(eq(contractors.id, invoice.contractor_id))
      if (contractor && contractor.contractor_type !== 'video_editor') {
        return Response.json(
          { error: '代行者への支払額の変更はダッシュボードの支払予定額から行ってください（NGの手動OKは編集者のみ対象です）' },
          { status: 400 }
        )
      }
    }
    if (!invoice.contractor_id || invoice.resolved_year === null || invoice.resolved_month === null) {
      return Response.json(
        { error: '委託者または対象月が特定できていないため、金額を確定できません（先に修正・再チェックを行ってください）' },
        { status: 400 }
      )
    }

    // 月次レコードは記載月ではなく支払月（記載月の翌月）に並ぶ。照合本体と同じ換算・同じ引き当て条件を使う。
    const payout = payoutMonthOf(invoice.resolved_year, invoice.resolved_month)
    const records = await findPayoutMonthlyRecords(invoice.contractor_id, payout.year, payout.month)
    if (records.length === 0) {
      return Response.json(
        { error: `${payout.year}年${payout.month}月分（支払月）の月次レコードが見つかりません` },
        { status: 400 }
      )
    }

    // 金額を入れる先は「まだ実支払額が入っていない行」。すべて埋まっているなら保留の原因は
    // 納品シート照合ではないので、ここで金額を上書きしても直らない。
    const pending = records.filter((r) => r.actualPayoutAmount === null)
    if (pending.length === 0) {
      return Response.json(
        { error: '実支払額はすでに入力済みです。保留の原因は納品シートの照合ではありません（判定理由をご確認ください）' },
        { status: 400 }
      )
    }
    // 入力欄は1つなので、金額を割り振る先が複数あると按分の根拠が無い。
    // クライアント別に金額が要るケースはダッシュボードで行ごとに入力してもらう。
    if (pending.length > 1) {
      return Response.json(
        {
          error: `支払額が未入力の月次レコードが複数あります（${pending
            .map((r) => r.clientName)
            .join(' / ')}）。ダッシュボードでクライアントごとに支払額を入力してください`,
        },
        { status: 400 }
      )
    }

    await db
      .update(monthlyRecords)
      .set({ actual_payout_amount: parsed.data.amount })
      .where(eq(monthlyRecords.id, pending[0].id))

    // 金額を入れただけでは判定（status）も判定理由も変わらないため、続けて照合まで終わらせる。
    const outcome = await checkInvoiceAndSave(id)
    if (!outcome) return Response.json({ error: 'Not found' }, { status: 404 })
    // 照合しなかった理由（読み取り失敗）も画面に出す必要があるため、内容として200で返す。
    return Response.json(outcome)
  } catch (err) {
    return serverError(err)
  }
}
