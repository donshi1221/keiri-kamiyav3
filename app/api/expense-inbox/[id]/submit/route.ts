import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { expenseUploads, expenseUploadItems } from '@/lib/schema'
import { verifyExpenseUploadToken } from '@/lib/expense-token'
import { expenseSubmitSchema, parseBody } from '@/lib/validation'
import { getResend } from '@/lib/resend'

// 公開エンドポイント（proxy.ts の認証除外）。代表が明細ごとの割り当てを送って経理へ回す。
// 受付（POST /api/expense-inbox）と同じトークンで入口を絞る。
export async function POST(req: NextRequest, ctx: RouteContext<'/api/expense-inbox/[id]/submit'>) {
  try {
    const { id } = await ctx.params
    const body: unknown = await req.json()

    // トークンは検証の可否そのものなので、入力の形の検証（zod）とは分けて先に見る。
    // 形式エラー(400)と権限エラー(401)を混ぜると、URLが無効なのか入力が悪いのか区別が付かないため。
    const token = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : null
    if (typeof token !== 'string' || !(await verifyExpenseUploadToken(token))) {
      return Response.json({ error: 'このURLは無効です。担当者に新しいURLをご確認ください。' }, { status: 401 })
    }

    const parsed = parseBody(expenseSubmitSchema, body)
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })

    const [upload] = await db
      .select({ id: expenseUploads.id, status: expenseUploads.status, file_name: expenseUploads.file_name })
      .from(expenseUploads)
      .where(eq(expenseUploads.id, id))
    if (!upload) return Response.json({ error: 'Not found' }, { status: 404 })

    // 送信済み以降の行は上書きさせない。経理が確認・登録した後に内容が変わると、
    // 登録済みの経費と手元の割り当てが食い違ってしまうため。
    if (upload.status !== 'draft') {
      return Response.json({ error: 'この経費ファイルはすでに送信済みです。' }, { status: 409 })
    }

    const rows = await db
      .select({ id: expenseUploadItems.id })
      .from(expenseUploadItems)
      .where(eq(expenseUploadItems.upload_id, id))
    const ownIds = new Set(rows.map((r) => r.id))

    // 公開エンドポイントなので、他の受付の明細IDを混ぜて送られる可能性を排除する。
    // 件数の一致も見て、画面が一部の行を落として送った場合は割り当て漏れとして弾く。
    const allOwn = parsed.data.items.every((item) => ownIds.has(item.id))
    if (!allOwn || parsed.data.items.length !== ownIds.size) {
      return Response.json({ error: '明細の内容が最新ではありません。画面を開き直してください。' }, { status: 400 })
    }

    // neon-http はトランザクションを張れないため1行ずつ更新する（明細は10件前後で件数が知れている）。
    for (const item of parsed.data.items) {
      await db
        .update(expenseUploadItems)
        .set({
          kind: item.kind,
          // 対象外の行にクライアントが残っていると、後から見て「請求するのか」が読めなくなる。
          // 検証では任意にしているため、意味の無い値はここで消してから保存する。
          client_id: item.kind === 'excluded' ? null : item.client_id,
        })
        .where(eq(expenseUploadItems.id, item.id))
    }

    await db
      .update(expenseUploads)
      .set({ status: 'submitted', submitted_at: new Date().toISOString() })
      .where(eq(expenseUploads.id, id))

    const items = await db
      .select()
      .from(expenseUploadItems)
      .where(eq(expenseUploadItems.upload_id, id))
      .orderBy(asc(expenseUploadItems.sort_order))

    // 通知は保険であり本業の受付を止めない。宛先未設定や送信失敗があっても経費の送信自体は成功として返す。
    try {
      if (!process.env.RESEND_API_KEY || !process.env.NOTIFICATION_EMAIL) {
        console.warn('[expense-inbox/submit] RESEND_API_KEY または NOTIFICATION_EMAIL が未設定のため通知メールをスキップしました。')
      } else {
        const resend = getResend()
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
        const { error: mailErr } = await resend.emails.send({
          from: 'keiri-v3 <noreply@resend.dev>',
          to: process.env.NOTIFICATION_EMAIL,
          subject: `[経費受付] 代表から経費が届きました（${upload.file_name}）`,
          text: [
            `代表から経費が届きました。`,
            '',
            `ファイル名: ${upload.file_name}`,
            `明細件数: ${items.length}件`,
            '',
            `確認はこちら: ${appUrl}/expense-check`,
          ].join('\n'),
        })
        if (mailErr) {
          console.error('[expense-inbox/submit] mail send failed:', mailErr)
        }
      }
    } catch (mailErr) {
      console.error('[expense-inbox/submit] mail send failed:', mailErr)
    }

    return Response.json({ id, status: 'submitted', items })
  } catch (err) {
    return serverError(err)
  }
}
