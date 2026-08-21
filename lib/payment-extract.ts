import 'server-only'
import { SchemaType, type Part, type ResponseSchema } from '@google/generative-ai'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { paymentRequests } from '@/lib/schema'
import { getGeminiClient } from '@/lib/gemini'
import {
  callAiWithRetry,
  createAiRetryBudget,
  effectiveRequestTimeoutMs,
  isTransientAiError,
  withRequestTimeout,
} from '@/lib/ai-retry'
import { GEMINI_MODEL_FALLBACKS, AI_REQUEST_MIN_TIMEOUT_MS } from '@/lib/config'
import { nowJST } from '@/lib/dates'
import type { PaymentExtracted, PaymentExtractOutcome } from '@/lib/ui-types'

// AIに返させるJSONの形。プロンプトの文章だけで形式を守らせようとすると
// 「はい、こちらが結果です」等の前置きが混ざってパースに失敗するため、スキーマで固定する。
const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    payee: {
      type: SchemaType.STRING,
      nullable: true,
      description: '振込先（振込先口座の名義、または請求書の発行者名）',
    },
    amount: { type: SchemaType.INTEGER, nullable: true, description: '振り込む金額（円）' },
    due_date: {
      type: SchemaType.STRING,
      nullable: true,
      description: '支払期日（YYYY-MM-DD）。年が特定できなければ null',
    },
  },
  required: ['payee', 'amount', 'due_date'],
}

// 経理が知りたいのは「どこへ・いくら・いつまでに」の3点だけ。明細や内訳は読ませない
// （読ませるほど1項目あたりの精度が落ち、確認の手間もかえって増えるため）。
const PROMPT = [
  'これは日本の請求書（または支払通知書・振込依頼書）です。振込に必要な次の項目だけを読み取ってJSONで返してください。',
  '',
  '- payee: 振込先。「お振込先」「振込先口座」欄の口座名義（カナ表記があればそれも含めて書かれているとおり）を返す。',
  '  口座名義の記載が無ければ、請求書の発行者（お金を受け取る側）の会社名・氏名を返す。',
  '  請求先（お金を払う側・宛名）と取り違えないこと。',
  '- amount: 実際に振り込む金額。税込かつ源泉徴収などの控除を反映した「最終的に振り込む金額」を整数の円で返す。',
  '  「小計」「消費税」ではなく「合計」「ご請求金額」「お振込金額」にあたる額を選ぶ。',
  '  カンマ・「円」「¥」は取り除いた正の整数（例: 132,000円 → 132000）で返す。',
  '- due_date: 支払期日（「お支払期限」「お振込期日」など）を YYYY-MM-DD で返す。',
  '  「月末」「翌月末」のように日が書かれていない場合は、その月の末日として返す。',
  '  年が書かれていないときは、下に伝える読み取り時点の年月から補う。',
  '  補った結果が読み取り時点より1か月以上前の日付になる場合は、翌年とみなす。',
  '  和暦（令和など）で書かれている場合は西暦に直す。',
  '  期日がどこにも書かれていない、または年が決まらないときは推測せず null にする。',
  '',
  '読み取れない項目は必ず null にすること（推測で埋めない）。人が原本を見て手で補えるようにするため。',
].join('\n')

// amount は integer 列。桁を読み違えた巨大な値をそのまま入れると保存自体が失敗するため、
// 列の上限（2^31-1）を超える金額は「読み取れなかった」扱いにする。
const MAX_AMOUNT = 2_147_483_647

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// 0円や負数の振込はありえない。読み違いの値をそのまま出すと経理が金額を信じてしまうため、
// 範囲外は null（＝読み取れなかった）に寄せて原本を見てもらう。
function normalizeAmount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const n = Math.round(value)
  return n > 0 && n <= MAX_AMOUNT ? n : null
}

// 日付は date 列にそのまま入れるため、形式が違う値を渡すとDBが生の500を返す。
// カレンダー上ありえない日（2026-02-31）もここで弾き、null＝人が直す、に寄せる。
function normalizeDate(value: unknown): string | null {
  const text = normalizeText(value)
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const [y, m, d] = text.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const valid = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  return valid ? text : null
}

// 振込依頼のファイル（PDFまたは画像）をAIに読ませ、振込先・金額・支払期日を取り出す。
// PDFはテキスト抽出を通さず inlineData でそのまま渡す。画像で届く請求書と処理を分けずに済み、
// 文字レイヤーの無いスキャンPDFでも読めるため（経費・請求書の読み取りと同じ方針）。
// 呼び出し側が「受付は成功・読み取りだけ失敗」を記録できるよう、失敗は throw せず error を返す。
export async function extractPayment(
  fileDataBase64: string,
  fileType: string,
  fileName: string
): Promise<PaymentExtractOutcome> {
  if (!process.env.GEMINI_API_KEY) {
    return { error: 'GEMINI_API_KEY が未設定のため読み取れませんでした。' }
  }

  // 年の記載が無い期日に年を補うための基準。書類にもファイル名にも年が無いときの最後の手がかりになる。
  const now = nowJST()
  const uploadedAt = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`

  const parts: Part[] = [
    { text: PROMPT },
    // ファイル名にも「2026年8月分」等の手がかりが入ることが多いので添える。
    { text: `ファイル名: ${fileName}` },
    { text: `読み取り時点の年月: ${uploadedAt}` },
    { inlineData: { mimeType: fileType, data: fileDataBase64 } },
  ]

  // 再試行とモデル切り替えを合わせた「全体の締め切り」。切り替えたぶん時間が延びて呼び出し元ルートの
  // maxDuration（60秒）を超えては本末転倒なので、モデルをまたいで1つの予算を使い回す。
  const budget = createAiRetryBudget()

  let raw: string | null = null
  let lastError: unknown = null
  for (let index = 0; index < GEMINI_MODEL_FALLBACKS.length; index++) {
    const modelName = GEMINI_MODEL_FALLBACKS[index]

    // 1回あたりの制限時間は残り予算で頭打ちにする（理由は effectiveRequestTimeoutMs のコメント）。
    const timeoutMs = effectiveRequestTimeoutMs(budget)

    // 数秒しか残っていない状態で次の候補を叩いても、応答が返る前に関数ごと打ち切られるだけ。
    // それより早く失敗理由を返してDBに書き戻すほうが、利用者は原因を追える。
    if (index > 0 && timeoutMs < AI_REQUEST_MIN_TIMEOUT_MS) {
      console.warn(`[payment-extract] 残り時間が足りないため ${modelName} 以降は試しません（残り ${timeoutMs}ms）。`)
      break
    }

    try {
      const model = getGeminiClient().getGenerativeModel(
        {
          model: modelName,
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        },
        // 混雑したモデルは失敗を返さず黙り込むことがある。SDKに1回あたりの制限時間を持たせ、
        // 自分から打ち切って次の候補へ移れるようにする（詳しい経緯は lib/config のコメント）。
        { timeout: timeoutMs }
      )
      // Gemini の混雑（503）・レート制限（429）は数秒おけば通ることが多い。失敗のまま残すと
      // 代表は再送できず、経理の一覧にも読み取り結果が出ないまま誰も復旧できなくなる。
      const result = await callAiWithRetry(
        `payment-extract:${modelName}`,
        () => withRequestTimeout(timeoutMs, () => model.generateContent(parts)),
        {
          budget,
          fallbacksRemaining: GEMINI_MODEL_FALLBACKS.length - index - 1,
        }
      )
      raw = result.response.text()
      // 1つ目で通ったのか、切り替えた結果として通ったのかを後から追えるように残す
      // （切り替えが常態化しているなら既定モデルの見直しどきだと分かる）。
      console.info(
        `[payment-extract] ${modelName} で読み取りに成功しました（候補 ${index + 1}/${GEMINI_MODEL_FALLBACKS.length}）。`
      )
      break
    } catch (err) {
      lastError = err
      console.error(`[payment-extract] ${modelName} で失敗しました:`, err)
      // 恒久的なエラー（400=入力不正、401=APIキー不正など）は別のモデルに投げても同じ結果になる。
      if (!isTransientAiError(err)) break
    }
  }

  if (raw === null) {
    // 全候補で駄目だったときは最後に試したモデルの理由をそのまま返す（利用者が原因を追えるように）。
    return {
      error:
        lastError instanceof Error
          ? `AIの読み取りに失敗しました（${lastError.message}）`
          : 'AIの読み取りに失敗しました。',
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { error: 'AIの応答をJSONとして解釈できませんでした。' }
  }

  const extracted: PaymentExtracted = {
    payee: normalizeText(parsed.payee),
    amount: normalizeAmount(parsed.amount),
    due_date: normalizeDate(parsed.due_date),
  }

  // 3項目とも空なら「ファイルが読めていない」に近い。空欄だけの行を出すと経理は原因が分からず
  // 再読み取りすべきかも判断できないため、失敗として理由を残す。
  if (extracted.payee === null && extracted.amount === null && extracted.due_date === null) {
    return { error: '振込先・金額・支払期日のいずれも読み取れませんでした（ファイルの内容をご確認ください）。' }
  }

  return extracted
}

// 読み取って同じ受付の行へ保存する。
// extract_error は成否をそのまま反映する（成功時は null に戻す＝再読み取りの結果が残る）。
export async function extractPaymentAndSave(
  id: string,
  fileDataBase64: string,
  fileType: string,
  fileName: string
): Promise<PaymentExtractOutcome> {
  const outcome = await extractPayment(fileDataBase64, fileType, fileName)
  const failed = 'error' in outcome

  await db
    .update(paymentRequests)
    .set({
      extracted_payee: failed ? null : outcome.payee,
      extracted_amount: failed ? null : outcome.amount,
      extracted_due_date: failed ? null : outcome.due_date,
      extract_error: failed ? outcome.error : null,
      extracted_at: new Date().toISOString(),
    })
    .where(eq(paymentRequests.id, id))

  return outcome
}
