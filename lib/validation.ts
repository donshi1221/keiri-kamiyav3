import { z } from 'zod'

// API入力の検証スキーマを1か所に集約する。
// 目的は「壊れたデータをDBに入れない」「型不一致でDBが生の500を返す事故を防ぐ」こと。
// 金額列は integer なので、小数はここで丸め、非数値・負数は弾く。

// 金額（円）: 数値化 → 有限かつ0以上を要求 → 整数に丸める（integer列に小数を渡すと500になるため）。
const moneyInt = z.coerce
  .number()
  .refine((n) => Number.isFinite(n), { message: '金額には数値を入力してください' })
  .refine((n) => n >= 0, { message: '金額は0以上で入力してください' })
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

export const clientCreateSchema = z.object({
  name: z.string().trim().min(1, { message: 'クライアント名は必須です' }),
  contact_person: z.string().nullish(),
  billing_amount: moneyInt.optional(),
  contract_start: z.string().nullish(),
  contract_months: monthsField.optional(),
  notes: z.string().nullish(),
})
export const clientPatchSchema = clientCreateSchema.partial()

export const contractorCreateSchema = z.object({
  name: z.string().trim().min(1, { message: '委託者名は必須です' }),
  contractor_type: z.enum(['daiko', 'video_editor']).optional(),
  email: optionalEmail.optional(),
  notes: z.string().nullish(),
})
export const contractorPatchSchema = contractorCreateSchema.partial()

export const assignmentCreateSchema = z.object({
  contractor_id: z.uuid({ message: '委託者の選択が不正です' }),
  client_id: z.uuid({ message: 'クライアントの選択が不正です' }),
  role_name: z.string().optional(),
  contractor_payout_amount: moneyInt.optional(),
  spreadsheet_url: optionalUrl.optional(),
  active: z.boolean().optional(),
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
