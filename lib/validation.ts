import { z } from 'zod'
import { EXPENSE_ITEM_KINDS, PAYROLL_KINDS, PAYMENT_REQUEST_STATUSES } from '@/lib/config'

// API入力の検証スキーマを1か所に集約する。
// 目的は「壊れたデータをDBに入れない」「型不一致でDBが生の500を返す事故を防ぐ」こと。
// 金額列は integer なので、小数はここで丸め、非数値・負数は弾く。

// 金額（円）: 数値化 → 有限かつ0以上を要求 → 整数に丸める（integer列に小数を渡すと500になるため）。
const moneyInt = z.coerce
  .number()
  .refine((n) => Number.isFinite(n), { message: '金額には数値を入力してください' })
  .refine((n) => n >= 0, { message: '金額は0以上で入力してください' })
  .transform((n) => Math.round(n))

// 本数: 数値化 → 有限かつ0以上を要求 → 整数に丸める（integer列に小数を渡すと500になるため）。
const countInt = z.coerce
  .number()
  .refine((n) => Number.isFinite(n), { message: '本数には数値を入力してください' })
  .refine((n) => n >= 0, { message: '本数は0以上で入力してください' })
  .transform((n) => Math.round(n))

// 契約期間（月）: 空文字/未指定/null は null（=期間なし）扱い。値があれば1以上の整数。
const monthsField = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : v),
  z.coerce
    .number()
    .int({ message: '契約期間は整数で入力してください' })
    .min(1, { message: '契約期間は1以上で入力してください' })
    .nullable()
)

// 空文字を null に寄せてから任意のメール/URLとして検証する（UIが空文字を送っても弾かない）。
const optionalEmail = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.email({ message: 'メールアドレスの形式が正しくありません' }).nullable()
)
const optionalUrl = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.url({ message: 'URLの形式が正しくありません' }).nullable()
)

// クライアント本体（内訳は含まない）。金額・契約期間は請求内訳（client_billing_items）側で管理する。
export const clientCreateSchema = z.object({
  name: z.string().trim().min(1, { message: 'クライアント名は必須です' }),
  // 請求書の明細に書かれる呼び名（通称・略称）。カンマ区切りの1行として保存し、
  // 分解は照合側（lib/invoice-check）で行う＝入力の見た目とDBの値を一致させる。
  aliases: z.string().nullish(),
  // 明細の「N/M」を支払回数ではなく日付（台本作成日など）として扱うクライアントの印。
  nm_as_date: z.boolean().optional(),
  contact_person: z.string().nullish(),
  monthly_video_count: countInt.optional(),
  notes: z.string().nullish(),
})
export const clientPatchSchema = clientCreateSchema.partial()

// 請求内訳（明細）。金額と契約期間を内訳ごとに個別に持つ。
export const billingItemCreateSchema = z.object({
  client_id: z.uuid({ message: 'クライアントの選択が不正です' }),
  label: z.string().trim().nullish(),
  billing_amount: moneyInt.optional(),
  contract_start: z.string().nullish(),
  contract_months: monthsField.optional(),
  active: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
})
export const billingItemPatchSchema = billingItemCreateSchema.partial().omit({ client_id: true })

// ChatworkルームID。受付URL（#!rid12345678）から数字だけを写してもらう欄なので、
// 「rid」付きや空白混じりの貼り付けをここで数字だけに寄せる（画面の入力を弾かずに済む）。
// 空欄は「未登録」＝null。数字以外が残る入力は、送信時に必ず失敗するので保存前に弾く。
const optionalChatworkRoomId = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v === undefined ? null : v
    // メッセージリンク付きURL（#!rid123-456 の形式）を貼られてもルームIDだけを取り出す。
    // ハイフン以降はメッセージIDで、混ざったまま保存すると送信が必ず失敗するため。
    const trimmed = v.trim()
    if (trimmed === '') return null
    const m = trimmed.match(/#!rid(\d+)/) ?? trimmed.match(/^(\d+)/)
    return m ? m[1] : trimmed
  },
  z.string().regex(/^\d+$/, { message: 'ChatworkルームIDは数字で入力してください' }).nullable()
)

export const contractorCreateSchema = z.object({
  name: z.string().trim().min(1, { message: '委託者名は必須です' }),
  contractor_type: z.enum(['daiko', 'video_editor']).optional(),
  unit_price: moneyInt.optional(),
  email: optionalEmail.optional(),
  chatwork_room_id: optionalChatworkRoomId.optional(),
  notes: z.string().nullish(),
})
export const contractorPatchSchema = contractorCreateSchema.partial()

export const assignmentCreateSchema = z.object({
  contractor_id: z.uuid({ message: '委託者の選択が不正です' }),
  client_id: z.uuid({ message: 'クライアントの選択が不正です' }),
  role_name: z.string().optional(),
  contractor_payout_amount: moneyInt.optional(),
  payment_start_month: z.string().regex(/^\d{4}-\d{2}$/, { message: '支払い開始月はYYYY-MM形式で入力してください' }).nullish(),
  payment_count: z.coerce.number().int().min(1, { message: '支払い回数は1回以上で入力してください' }).nullish(),
  spreadsheet_url: optionalUrl.optional(),
  active: z.boolean().optional(),
})

// 立替経費（交通費など）。代行者のアサインに紐づけ、同額をクライアントへ請求する。
// year/month は「どの月の支払い・請求に乗せるか」で、expense_date（記録用の日付）とは別に持つ。
export const expenseCreateSchema = z.object({
  assignment_id: z.uuid({ message: 'アサインの指定が不正です' }),
  year: z.coerce.number().int().min(2000).max(3000),
  month: z.coerce.number().int().min(1).max(12),
  expense_date: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: '日付はYYYY-MM-DD形式で入力してください' }).nullable()
  ),
  amount: moneyInt,
  note: z.string().trim().nullish(),
})

// 自社が直接払った経費（素材購入費・広告費など）。委託者を経由しないためクライアントへ直接ぶら下げる。
// 委託者への支払いには一切乗らず、クライアントへの請求にだけ加算される点が立替経費と異なる。
export const clientExpenseCreateSchema = z.object({
  client_id: z.uuid({ message: 'クライアントの指定が不正です' }),
  year: z.coerce.number().int().min(2000).max(3000),
  month: z.coerce.number().int().min(1).max(12),
  expense_date: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: '日付はYYYY-MM-DD形式で入力してください' }).nullable()
  ),
  amount: moneyInt,
  note: z.string().trim().nullish(),
})

// ─── 請求書チェック（読み取り結果の手動修正）─────────────────────────────
// extracted_* は「読み取れなかった」を null で表す列。空欄を 0 や空文字に丸めると
// 「請求書にそう書いてあった」と区別が付かなくなるため、未入力は必ず null に寄せる。
// integer列の上限を超える値はDB側で生の500になるため、ここで弾く。
const INT4_MAX = 2147483647

function nullableIntField(min: number, max: number, message: string) {
  return z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? null : v),
    z.coerce
      .number({ message })
      .int({ message })
      .min(min, { message })
      .max(max, { message })
      .nullable()
  )
}

const optionalTrimmedText = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v === undefined ? null : v
    const trimmed = v.trim()
    return trimmed === '' ? null : trimmed
  },
  z.string().nullable()
)

// 画面の修正フォームは5項目すべてを毎回送る（＝空欄はその項目を消す意思）。
// このため未送信は「部分更新の対象外」ではなく null 扱いにしている。
export const invoiceExtractedPatchSchema = z.object({
  extracted_amount: nullableIntField(0, INT4_MAX, '請求額は0以上の整数で入力してください'),
  extracted_issuer: optionalTrimmedText,
  extracted_addressee: optionalTrimmedText,
  extracted_year: nullableIntField(2000, 2100, '対象年は2000〜2100の範囲で入力してください'),
  extracted_month: nullableIntField(1, 12, '対象月は1〜12の範囲で入力してください'),
})

// 注意行の「確認済みにする / 取り消す」。key は画面が注意行の本文から復元したキー
// （lib/invoice-match の cautionKeyOf）で、invoice_uploads.confirmed_cautions に貯める。
export const cautionConfirmSchema = z.object({
  key: z.string().trim().min(1, { message: '確認対象の注意を特定できません' }),
  confirmed: z.boolean({ message: 'confirmed は true / false で指定してください' }),
})

// ─── 請求書未提出リマインド（Chatwork）─────────────────────────────
// template は画面で編集された文面。プレースホルダの置換はサーバー側で行うため、ここでは中身を検証しない。
// 誤って全員に空文にすることを防ぐため、空文字だけは弾く。
export const invoiceReminderSendSchema = z.object({
  year: z.coerce.number().int().min(2000).max(3000),
  month: z.coerce.number().int().min(1).max(12),
  contractorIds: z.array(z.uuid({ message: '委託者の指定が不正です' })).min(1, { message: '送信先を1人以上選んでください' }),
  template: z.string().trim().min(1, { message: '文面を入力してください' }),
})

// ─── 経費アップロード（代表の割り当て送信）─────────────────────────────
// 明細1行ごとに「用途（kind）」と「どのクライアントの分か（client_id）」を代表が選ぶ。
// 必須の条件が用途で変わるため、行単位で superRefine を掛ける:
//   client_billed … クライアントへ請求するので請求先が要る
//   company       … 自社経費。クライアントに紐づかないので client_id は任意
//   excluded      … 対象外。どこにも計上しないため不要
const expenseItemClientId = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.uuid({ message: 'クライアントの指定が不正です' }).nullable()
)

const expenseItemAssignSchema = z
  .object({
    id: z.uuid({ message: '明細の指定が不正です' }),
    kind: z.enum(EXPENSE_ITEM_KINDS, { message: '用途を選んでください' }),
    client_id: expenseItemClientId,
  })
  .superRefine((item, ctx) => {
    if (item.kind === 'client_billed' && !item.client_id) {
      ctx.addIssue({ code: 'custom', path: ['client_id'], message: 'クライアントに請求する明細はクライアントを選んでください' })
    }
  })

// 明細が1件も無い送信は、読み取り前・読み取り失敗のまま送られた事故なので弾く。
export const expenseSubmitSchema = z.object({
  items: z.array(expenseItemAssignSchema).min(1, { message: '明細が1件もありません' }),
})

// 経理の登録時に、明細ごとの「請求月」を経理が選べるようにするための指定。
// 利用月と請求月がずれる運用（月末の利用を翌々月に回す等）があり、翌月固定では直せなかったため。
// items が無い呼び出し（ドライブ保存の再試行）も正当なので配列ごと任意にする。
// 利用月との整合（利用月〜翌々月に収まっているか）は明細の利用日が要るため、ここではなくAPI側で見る。
export const expenseApproveSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.uuid({ message: '明細の指定が不正です' }),
        year: z.coerce.number().int().min(2000).max(2100),
        month: z.coerce.number().int().min(1).max(12),
      })
    )
    .optional(),
  // 代表が立て替えた分として、役員の立替精算に乗せる明細のID。
  // 請求月（items）とは無関係に決まる（請求はクライアントへの話、精算は本人へ返す話で相手が違う）ため
  // 別の配列で受ける。会社カード決済など返金が要らない明細は経理が外すので、指定が無い＝1件も乗せない。
  reimburseItemIds: z.array(z.uuid({ message: '明細の指定が不正です' })).optional(),
})

// ─── 役員報酬・給与 ─────────────────────────────
// 控除額はユーザーが登録した値をそのまま使う（料率表は持たない）ので、検証は「0以上の整数」だけ。
// pay_day は空欄＝未設定（既定日で扱う）なので null に寄せる。
const payDayField = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : v),
  z.coerce
    .number()
    .int({ message: '支払日は整数で入力してください' })
    .min(1, { message: '支払日は1〜31で入力してください' })
    .max(31, { message: '支払日は1〜31で入力してください' })
    .nullable()
)

export const payrollRecipientCreateSchema = z.object({
  name: z.string().trim().min(1, { message: '氏名は必須です' }),
  kind: z.enum(PAYROLL_KINDS, { message: '種別を選んでください' }),
  gross_amount: moneyInt.optional(),
  health_insurance: moneyInt.optional(),
  pension: moneyInt.optional(),
  employment_insurance: moneyInt.optional(),
  income_tax: moneyInt.optional(),
  resident_tax: moneyInt.optional(),
  pay_day: payDayField.optional(),
  active: z.boolean().optional(),
})
export const payrollRecipientPatchSchema = payrollRecipientCreateSchema.partial()

// 月次レコードの金額修正（料率改定の月に、その月の控えだけを直す）。
// 送られてきた項目だけを更新するため全項目を任意にする。
export const payrollSnapshotPatchSchema = z.object({
  gross_snapshot: moneyInt.optional(),
  health_insurance_snapshot: moneyInt.optional(),
  pension_snapshot: moneyInt.optional(),
  employment_insurance_snapshot: moneyInt.optional(),
  income_tax_snapshot: moneyInt.optional(),
  resident_tax_snapshot: moneyInt.optional(),
})

// 立替経費の精算明細。金額は0円を許さない（0円の立替は精算する意味が無く、
// 打ち間違いで入った空行が振込額の内訳を汚すだけのため）。
// year/month は「どの月の給与に乗せるか」で、item_date（立て替えた日）とは別に持つ。
export const payrollReimbursementCreateSchema = z.object({
  recipient_id: z.uuid({ message: '支給対象者の指定が不正です' }),
  year: z.coerce.number().int().min(2000).max(3000),
  month: z.coerce.number().int().min(1).max(12),
  item_date: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: '利用日はYYYY-MM-DD形式で入力してください' }).nullable()
  ).optional(),
  description: z.string().trim().min(1, { message: '項目は必須です' }),
  amount: z.coerce
    .number()
    .refine((n) => Number.isFinite(n), { message: '金額には数値を入力してください' })
    .transform((n) => Math.round(n))
    .refine((n) => n >= 1, { message: '金額は1円以上で入力してください' }),
})

// 編集は送られてきた項目だけを更新する。対象者・月は行を作り直す方が事故が少ないので変更させない。
export const payrollReimbursementPatchSchema = payrollReimbursementCreateSchema
  .partial()
  .omit({ recipient_id: true, year: true, month: true })

// 振込依頼の状態変更（PATCH /api/payment-requests/[id]）。
// 状態は text 列だが、任意の文字列を入れられると画面のバッジも件数の集計も破綻するため、
// 受け付ける値を選択肢（lib/config）に限る。時刻列（reserved_at 等）はサーバーが状態から導くので受け取らない
//（クライアントに時刻を決めさせると、状態と時刻が食い違った行が作れてしまう）。
export const paymentRequestPatchSchema = z.object({
  status: z.enum(PAYMENT_REQUEST_STATUSES, { message: '状態の指定が不正です' }),
})

export const snapshotBackfillSchema = z.object({
  year: z.coerce.number().int().min(2000).max(3000),
  month: z.coerce.number().int().min(1).max(12),
  // fill-missing: 欠損(null)のみ補完 / overwrite: 現マスタ値で全上書き
  mode: z.enum(['fill-missing', 'overwrite']).default('fill-missing'),
})

type ParseResult<T> = { ok: true; data: T } | { ok: false; message: string }

// スキーマで body を検証し、失敗時は最初のエラーメッセージ（利用者向け）を返す。
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): ParseResult<T> {
  const result = schema.safeParse(body)
  if (!result.success) {
    const first = result.error.issues[0]
    return { ok: false, message: first?.message ?? '入力内容が正しくありません' }
  }
  return { ok: true, data: result.data }
}
