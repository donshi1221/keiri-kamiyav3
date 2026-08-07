import 'server-only'
import { SchemaType, type ResponseSchema } from '@google/generative-ai'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { invoiceUploads } from '@/lib/schema'
import { getGeminiClient } from '@/lib/gemini'
import { GEMINI_MODEL } from '@/lib/config'
import type { InvoiceExtracted, InvoiceExtractOutcome } from '@/lib/ui-types'

// AIに返させるJSONの形。プロンプトの文章だけで形式を守らせようとすると
// 「はい、こちらが結果です」等の前置きが混ざってパースに失敗するため、スキーマで固定する。
const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    amount: { type: SchemaType.INTEGER, nullable: true, description: '請求合計額（税込・控除後の最終請求額、円）' },
    issuer: { type: SchemaType.STRING, nullable: true, description: '差出人（請求書の発行者名）' },
    addressee: { type: SchemaType.STRING, nullable: true, description: '宛名（請求先の名称）' },
    year: { type: SchemaType.INTEGER, nullable: true, description: '対象月の年（西暦）' },
    month: { type: SchemaType.INTEGER, nullable: true, description: '対象月の月（1〜12）' },
  },
  required: ['amount', 'issuer', 'addressee', 'year', 'month'],
}

const PROMPT = [
  'これは日本の請求書PDFです。次の項目を読み取ってJSONで返してください。',
  '',
  '- amount: 請求合計額。税込かつ源泉徴収などの控除を反映した「最終的に振り込む金額」を整数の円で返す。',
  '  「小計」「消費税」ではなく「合計」「ご請求金額」「お振込金額」にあたる額を選ぶこと。',
  '- issuer: 差出人。請求書を発行した側（お金を受け取る側）の氏名または会社名。',
  '- addressee: 宛名。請求先（お金を払う側）の氏名または会社名。「御中」「様」は含めない。',
  '- year / month: 「◯年◯月分」として請求されている対象月。',
  '  年が書かれていない場合、year は推定せず null にする（month だけ返してよい）。',
  '  和暦（令和など）で書かれている場合は西暦に直す。',
  '',
  '読み取れない項目、判断がつかない項目は必ず null にすること（推測で埋めない）。',
].join('\n')

const MIN_YEAR = 2000
const MAX_YEAR = 2100
// extracted_amount は integer 列。桁を読み違えた巨大な値をそのまま入れると保存自体が失敗するため、
// 列の上限（2^31-1）を超える金額は「読み取れなかった」扱いにする。
const MAX_AMOUNT = 2_147_483_647

// AIは指示に反した値（範囲外の年・負の金額・空文字）を返しうる。
// そのままDBに入れると画面上で誤読の原因になるため、ありえない値は null に落とす。
function normalizeInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const n = Math.round(value)
  return n >= min && n <= max ? n : null
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// 請求書PDFをAIに読ませ、金額・差出人・宛名・対象月を取り出す。
// PDFはテキスト抽出（pdf-parse）を通さず inlineData でそのまま渡す。
// スキャン画像のPDF（文字レイヤーが無い＝テキスト抽出では空になる）でも読めるようにするため。
// 呼び出し側が「アップロードは成功・読み取りだけ失敗」を記録できるよう、失敗は throw せず error を返す。
export async function extractInvoice(fileDataBase64: string, fileName: string): Promise<InvoiceExtractOutcome> {
  if (!process.env.GEMINI_API_KEY) {
    return { error: 'GEMINI_API_KEY が未設定のため読み取れませんでした。' }
  }

  let raw: string
  try {
    const model = getGeminiClient().getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    })
    const result = await model.generateContent([
      { text: PROMPT },
      // ファイル名にも「6月分」等の手がかりが入ることが多いので添える。
      { text: `ファイル名: ${fileName}` },
      { inlineData: { mimeType: 'application/pdf', data: fileDataBase64 } },
    ])
    raw = result.response.text()
  } catch (err) {
    console.error('[invoice-extract]', err)
    return { error: err instanceof Error ? `AIの読み取りに失敗しました（${err.message}）` : 'AIの読み取りに失敗しました。' }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { error: 'AIの応答をJSONとして解釈できませんでした。' }
  }

  const extracted: InvoiceExtracted = {
    amount: normalizeInt(parsed.amount, 0, MAX_AMOUNT),
    issuer: normalizeText(parsed.issuer),
    addressee: normalizeText(parsed.addressee),
    year: normalizeInt(parsed.year, MIN_YEAR, MAX_YEAR),
    month: normalizeInt(parsed.month, 1, 12),
  }

  // 1項目も取れないのは「PDFが読めていない」に近い。空欄が並ぶだけだと原因が分からず
  // 再読み取りの判断もできないため、失敗として理由を残す。
  if (Object.values(extracted).every((v) => v === null)) {
    return { error: '請求書の内容を読み取れませんでした（PDFの内容をご確認ください）。' }
  }

  return extracted
}

// 読み取って結果を同じ行に書き戻す。受付直後と画面からの再読み取りで同じ処理を使う。
// extracted_at は成否に関わらず更新する（いつ試したかが分からないと再読み取りの判断ができないため）。
export async function extractInvoiceAndSave(
  id: string,
  fileDataBase64: string,
  fileName: string
): Promise<InvoiceExtractOutcome> {
  const outcome = await extractInvoice(fileDataBase64, fileName)
  const failed = 'error' in outcome
  await db
    .update(invoiceUploads)
    .set({
      extracted_amount: failed ? null : outcome.amount,
      extracted_issuer: failed ? null : outcome.issuer,
      extracted_addressee: failed ? null : outcome.addressee,
      extracted_year: failed ? null : outcome.year,
      extracted_month: failed ? null : outcome.month,
      extract_error: failed ? outcome.error : null,
      extracted_at: new Date().toISOString(),
    })
    .where(eq(invoiceUploads.id, id))
  return outcome
}
