import { z } from 'zod'
import { EXPENSE_ITEM_KINDS, PAYROLL_KINDS } from '@/lib/config'

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
  // 立替経費の実費精算。控除の計算には関わらず、手取りに足すだけの項目。
  expense_reimbursement: moneyInt.optional(),
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
