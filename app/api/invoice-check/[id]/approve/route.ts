import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { contractors, invoiceUploads, monthlyRecords } from '@/lib/schema'
import {
  buildManualApprovePreview,
  checkInvoiceAndSave,
  findPayoutMonthlyRecords,
  payoutMonthOf,
} from '@/lib/invoice-check'
import { parseBody, invoiceManualApproveSchema } from '@/lib/validation'
import { and, eq, isNull } from 'drizzle-orm'

// 実支払額を入れた後に照合をやり直す。同じ委託者の他のアサインで納品シート（外部）を
// 読みにいくことがあるため、recheck 側と同じ理由で既定より長い実行時間を許可する。
// 割り当て案（GET）も支払予定額を出すために納品シートを読むので、同じ設定がそのまま要る。
export const maxDuration = 60

// 手動OKの対象になる請求書と、金額を入れる先（実支払額が未入力の月次レコード）。
type ApproveTarget = {
  contractorId: string
  payout: { year: number; month: number }
  pending: { id: string; clientName: string }[]
}

// 手動OKができる状態かを確かめ、金額を入れる先の行を引く。
// 割り当て案（GET）と確定（POST）で条件や文言が食い違うと、「案は出たのに確定で断られる」ことになるため共用する。
async function loadApproveTarget(id: string): Promise<{ target: ApproveTarget } | { response: Response }> {
  const [invoice] = await db
    .select({
      status: invoiceUploads.status,
      contractor_id: invoiceUploads.contractor_id,
      resolved_year: invoiceUploads.resolved_year,
      resolved_month: invoiceUploads.resolved_month,
    })
    .from(invoiceUploads)
    .where(eq(invoiceUploads.id, id))
  if (!invoice) return { response: Response.json({ error: 'Not found' }, { status: 404 }) }

  // OK・pendingの行にこの操作を許すと、判定が合っていないのに金額だけ確定してしまう。
  // 対象は「材料が足りずに結論が出せなかった」保留の行と、
  // 「編集者のイレギュラー請求で実支払額を優先すれば直る」NGの行に限る。
  if (invoice.status !== 'hold' && invoice.status !== 'ng') {
    return { response: Response.json({ error: '保留またはNGの請求書だけが手動OKの対象です' }, { status: 400 }) }
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
      return {
        response: Response.json(
          { error: '代行者への支払額の変更はダッシュボードの支払予定額から行ってください（NGの手動OKは編集者のみ対象です）' },
          { status: 400 }
        ),
      }
    }
  }
  if (!invoice.contractor_id || invoice.resolved_year === null || invoice.resolved_month === null) {
    return {
      response: Response.json(
        { error: '委託者または対象月が特定できていないため、金額を確定できません（先に修正・再チェックを行ってください）' },
        { status: 400 }
      ),
    }
  }

  // 月次レコードは記載月ではなく支払月（記載月の翌月）に並ぶ。照合本体と同じ換算・同じ引き当て条件を使う。
  const payout = payoutMonthOf(invoice.resolved_year, invoice.resolved_month)
  const records = await findPayoutMonthlyRecords(invoice.contractor_id, payout.year, payout.month)
  if (records.length === 0) {
    return {
      response: Response.json(
        { error: `${payout.year}年${payout.month}月分（支払月）に金額を入れられる月次レコードが見つかりません（スキップした行は対象外です）` },
        { status: 400 }
      ),
    }
  }

  // 金額を入れる先は「まだ実支払額が入っていない行」。すべて埋まっているなら保留の原因は
  // 納品シート照合ではないので、ここで金額を上書きしても直らない。
  const pending = records.filter((r) => r.actualPayoutAmount === null)
  if (pending.length === 0) {
    return {
      response: Response.json(
        { error: '実支払額はすでに入力済みです。保留の原因は納品シートの照合ではありません（判定理由をご確認ください）' },
        { status: 400 }
      ),
    }
  }

  return {
    target: {
      contractorId: invoice.contractor_id,
      payout,
      pending: pending.map((r) => ({ id: r.id, clientName: r.clientName })),
    },
  }
}

// 手動OKの割り当て案。未入力の行が複数あるとき、請求書の明細からクライアント別の金額を出して
// 入力欄の初期値にする（人が請求書を見ながら按分を計算し直さずに済むようにするため）。
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/invoice-check/[id]/approve'>
) {
  try {
    const { id } = await ctx.params
    const loaded = await loadApproveTarget(id)
    if ('response' in loaded) return loaded.response
    const { contractorId, payout, pending } = loaded.target

    const preview = await buildManualApprovePreview(id, contractorId, payout, pending)
    if (!preview) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(preview)
  } catch (err) {
    return serverError(err)
  }
}

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

    const loaded = await loadApproveTarget(id)
    if ('response' in loaded) return loaded.response
    const { pending } = loaded.target

    // 未入力の行すべてに1つずつ金額が付いていることを確かめる。一部だけ入れると残りの行で
    // 納品シート照合が走り、押した人の意図と違う結果になる。画面を開いた後に行が増減した
    // （ダッシュボードで入力された・スキップされた）場合もここで止まる。
    const pendingIds = new Set(pending.map((r) => r.id))
    const allocatedIds = new Set(parsed.data.allocations.map((a) => a.recordId))
    const matchesPending =
      parsed.data.allocations.length === pendingIds.size &&
      allocatedIds.size === pendingIds.size &&
      [...allocatedIds].every((recordId) => pendingIds.has(recordId))
    if (!matchesPending) {
      return Response.json(
        { error: '支払額を入れる行が、画面を開いたときから変わっています。画面を更新してからやり直してください' },
        { status: 400 }
      )
    }

    // 行ごとの書き込みが途中で失敗して一部だけ入ると、上と同じく残りの行で納品シート照合が走る。
    // neon-http は db.transaction が使えないので、全部成功か全部失敗かになる db.batch でまとめる。
    // isNull を重ねているのは、行を引いてから書くまでの間に人が手で入れた値を消さないため。
    const [first, ...rest] = parsed.data.allocations.map((a) =>
      db
        .update(monthlyRecords)
        .set({ actual_payout_amount: a.amount })
        .where(and(eq(monthlyRecords.id, a.recordId), isNull(monthlyRecords.actual_payout_amount)))
    )
    await db.batch([first, ...rest])

    // 金額を入れただけでは判定（status）も判定理由も変わらないため、続けて照合まで終わらせる。
    const outcome = await checkInvoiceAndSave(id, { trigger: 'approve', origin: req.nextUrl.origin })
    if (!outcome) return Response.json({ error: 'Not found' }, { status: 404 })
    // 照合しなかった理由（読み取り失敗）も画面に出す必要があるため、内容として200で返す。
    return Response.json(outcome)
  } catch (err) {
    return serverError(err)
  }
}
