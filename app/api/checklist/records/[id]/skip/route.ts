import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { monthlyRecords } from '@/lib/schema'
import { and, eq, isNull } from 'drizzle-orm'

// 委託者へのその月の支払いをスキップする（払わずに終わり。契約の終了月は動かさない）。
// 行を消さずに印を付けるだけにしているのは、消すと月次生成が同じ月の行を作り直してしまうため。
// 返り値は PATCH /api/checklist/records/[id] と同じ「更新後の行」。
export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/checklist/records/[id]/skip'>
) {
  try {
    const { id } = await ctx.params
    const [row] = await db.select().from(monthlyRecords).where(eq(monthlyRecords.id, id))
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    // 支払い・振込予約が済んだ行は実際にお金が動いている（動く予定になっている）ため、
    // 印だけ付けると記録と実際の支払いが食い違う。
    if (row.contractor_paid_at) return Response.json({ error: '支払い済みの行はスキップできません。' }, { status: 400 })
    if (row.payment_reserved_at) {
      return Response.json({ error: '振込予約済みの行はスキップできません。先に支払い予約のチェックを外してください。' }, { status: 400 })
    }
    // まとめ行は後ろの月の分も抱えているため、スキップすると「その月だけ払わない」では済まなくなる。
    if (row.months_covered > 1) {
      return Response.json({ error: '残りをまとめた行はスキップできません。先にまとめを取り消してください。' }, { status: 400 })
    }

    // 二重送信やリトライで「いつスキップを決めたか」が後ろへずれないよう、最初の日時を保つ。
    if (row.skipped_at) return Response.json(row)

    // where に同じ条件を重ねているのは、判定から更新までの間に付いた支払い・予約の記録を
    // 見落としたままスキップにしないための二重の歯止め。
    const [data] = await db.update(monthlyRecords)
      .set({ skipped_at: new Date().toISOString() })
      .where(
        and(
          eq(monthlyRecords.id, id),
          isNull(monthlyRecords.contractor_paid_at),
          isNull(monthlyRecords.payment_reserved_at),
          eq(monthlyRecords.months_covered, 1)
        )
      )
      .returning()
    if (!data) {
      return Response.json({ error: '行の状態が変わったためスキップできませんでした。画面を読み込み直してください。' }, { status: 409 })
    }
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

// スキップを取り消し、通常の行に戻す。金額や受領の記録には触っていないので印を外すだけでよい。
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/checklist/records/[id]/skip'>
) {
  try {
    const { id } = await ctx.params
    const [data] = await db.update(monthlyRecords)
      .set({ skipped_at: null })
      .where(eq(monthlyRecords.id, id))
      .returning()
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}
