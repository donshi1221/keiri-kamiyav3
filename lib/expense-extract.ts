import 'server-only'
import { SchemaType, type Part, type ResponseSchema } from '@google/generative-ai'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { expenseUploads, expenseUploadItems } from '@/lib/schema'
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
import type { ExpenseExtractedItem, ExpenseExtractOutcome } from '@/lib/ui-types'

// AIに返させるJSONの形。プロンプトの文章だけで形式を守らせようとすると
// 「はい、こちらが結果です」等の前置きが混ざってパースに失敗するため、スキーマで固定する。
const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    items: {
      type: SchemaType.ARRAY,
      description: '利用明細の全行（原本に書かれている順）',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          item_date: {
            type: SchemaType.STRING,
            nullable: true,
            description: '利用日（YYYY-MM-DD）。年が特定できなければ null',
          },
          from_place: { type: SchemaType.STRING, nullable: true, description: '利用区間の起点。区間が無ければ null' },
          to_place: { type: SchemaType.STRING, nullable: true, description: '利用区間の終点。区間が無ければ null' },
          description: { type: SchemaType.STRING, nullable: true, description: '内容（「鉄道利用」「特急券」など）' },
          amount: { type: SchemaType.INTEGER, nullable: true, description: '利用額（円）。符号は付けず正の数で返す' },
        },
        required: ['item_date', 'from_place', 'to_place', 'description', 'amount'],
      },
    },
  },
  required: ['items'],
}

// 原本は「モバイルICOCAの1か月分の利用履歴PDF（明細10件前後）」か「特急券などの領収書1枚」の
// どちらかで届く。表の列名・レイアウトを具体的に示さないと、残額の列を利用額と取り違える。
const PROMPT = [
  'これは日本の交通費に関する書類です（モバイルICOCAの利用履歴、または特急券などの領収書）。',
  '利用明細を1行ずつ読み取ってJSONで返してください。',
  '',
  '利用履歴は次のような表になっています。',
  '  利用月日 / 利用箇所（区間） / 内容 / 利用額 / カード残額',
  '  例: 07/30  神高阪急三宮  神鉄長田  鉄道利用  -350 円  1,760 円',
  '',
  '- item_date: 利用日を YYYY-MM-DD で返す。',
  '  原本の日付には年が書かれていない（「07/30」など）ことが多い。その場合は書類内の',
  '  「2026/07」「2026年7月ご利用分」などの記載や、下に伝えるアップロード時点の年月から年を補うこと。',
  '  補った結果がアップロード時点より未来の日付になる場合は、その前の年とみなす。',
  '  どうしても年が決まらないときは推測せず null にする（人が直せるようにするため）。',
  '- from_place / to_place: 利用箇所の区間。「神高阪急三宮 神鉄長田」なら from_place=神高阪急三宮、to_place=神鉄長田。',
  '  区間が書かれていない書類（領収書など）は両方 null にする。',
  '- description: 内容欄の文字（「鉄道利用」「バス利用」「特急券」など）。無ければ null。',
  '- amount: 利用額。原本はマイナス表記（「-350 円」）だが、符号もカンマも取り除いた正の整数（350）で返す。',
  '  「カード残額」「残高」の列の数字は利用額ではないので絶対に使わないこと。',
  '',
  '同じ日に往復2行が並ぶことがあるが、まとめずにそれぞれ別の行として返す。',
  '「チャージ」「入金」など支出でない行、および「合計」などの集計行は含めない。',
  '読み取れない項目は必ず null にすること（推測で埋めない）。',
].join('\n')

// amount は integer 列。桁を読み違えた巨大な値をそのまま入れると保存自体が失敗するため、
// 列の上限（2^31-1）を超える金額は「読み取れなかった」扱いにする。
const MAX_AMOUNT = 2_147_483_647

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// 原本はマイナス表記だが経費としては正の数で扱うため、絶対値に直してから範囲を確かめる。
// 読めなかった行は 0 で残す（行ごと落とすと原本の見た目と対応が取れず、人が直せなくなる）。
function normalizeAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const n = Math.abs(Math.round(value))
  return n <= MAX_AMOUNT ? n : 0
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

// 明細は配列・オブジェクトの入れ子でスカラー項目より崩れやすい。
// 日付も区間も内容も金額も無い行は原本のどこにも対応しない（空行の読み違い）ので、行ごと捨てる。
function normalizeItems(value: unknown): ExpenseExtractedItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): ExpenseExtractedItem[] => {
    if (typeof raw !== 'object' || raw === null) return []
    const item = raw as Record<string, unknown>
    const normalized: ExpenseExtractedItem = {
      item_date: normalizeDate(item.item_date),
      from_place: normalizeText(item.from_place),
      to_place: normalizeText(item.to_place),
      description: normalizeText(item.description),
      amount: normalizeAmount(item.amount),
    }
    const empty =
      normalized.item_date === null &&
      normalized.from_place === null &&
      normalized.to_place === null &&
      normalized.description === null &&
      normalized.amount === 0
    return empty ? [] : [normalized]
  })
}

// 経費ファイル（PDFまたは画像）をAIに読ませ、明細1行ずつを取り出す。
// PDFはテキスト抽出を通さず inlineData でそのまま渡す。画像で届く領収書と処理を分けずに済み、
// 文字レイヤーの無いスキャンPDFでも読めるため。
// 呼び出し側が「アップロードは成功・読み取りだけ失敗」を記録できるよう、失敗は throw せず error を返す。
export async function extractExpense(
  fileDataBase64: string,
  fileType: string,
  fileName: string
): Promise<ExpenseExtractOutcome> {
  if (!process.env.GEMINI_API_KEY) {
    return { error: 'GEMINI_API_KEY が未設定のため読み取れませんでした。' }
  }

  // 年の記載が無い明細に年を補うための基準。書類にもファイル名にも年が無いときの最後の手がかりになる。
  const now = nowJST()
  const uploadedAt = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`

  const parts: Part[] = [
    { text: PROMPT },
    // ファイル名にも「2026年7月分」等の手がかりが入ることが多いので添える。
    { text: `ファイル名: ${fileName}` },
    { text: `アップロード時点の年月: ${uploadedAt}` },
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
      console.warn(`[expense-extract] 残り時間が足りないため ${modelName} 以降は試しません（残り ${timeoutMs}ms）。`)
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
        // 混雑したモデルは「失敗を返す」のではなく、何も返さないまま黙り込むことがある（実測で113秒以上）。
        // 失敗が返ってこない以上、下の締め切り判定は一度も動けず、待っているうちに呼び出し元ルートの
        // maxDuration（60秒）で関数ごと落とされて記録すら残らない。SDKに1回あたりの制限時間を持たせ、
        // 自分から打ち切って次の候補へ移れるようにする。
        { timeout: timeoutMs }
      )
      // Gemini の混雑（503）・レート制限（429）は数秒おけば通ることが多い。ここで自動的にやり直すのは、
      // 失敗のまま残すと代表は再送できず、経理の一覧にも出ないまま誰も復旧できなくなるため。
      // 残りの候補数を渡しておくと、残り時間が少ないときに同じモデルへの再試行が見送られ、
      // 別モデルへ移る時間が確保される（混雑したモデルは再試行しても遅いだけのことが多いため）。
      // withRequestTimeout で包むのは、制限時間による中断を「一時的な失敗」と判定させ、
      // モデル切り替えにつなげるため（包まないと中断として再試行されず、切り替えが起きない）。
      const result = await callAiWithRetry(
        `expense-extract:${modelName}`,
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
        `[expense-extract] ${modelName} で読み取りに成功しました（候補 ${index + 1}/${GEMINI_MODEL_FALLBACKS.length}）。`
      )
      break
    } catch (err) {
      lastError = err
      console.error(`[expense-extract] ${modelName} で失敗しました:`, err)
      // 恒久的なエラー（400=入力不正、401=APIキー不正など）は別のモデルに投げても同じ結果になる。
      // 待たせるだけ無駄なので、その時点で失敗として理由を返す。
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

  const items = normalizeItems(parsed.items)
  // 1行も取れないのは「ファイルが読めていない」に近い。空の一覧を出すだけだと原因が分からず
  // 再送すべきかも判断できないため、失敗として理由を残す。
  if (items.length === 0) {
    return { error: '利用明細を読み取れませんでした（ファイルの内容をご確認ください）。' }
  }

  return { items }
}

// 読み取って同じ受付の明細として保存する。
// extract_error は成否をそのまま反映する（成功時は null に戻す＝再読み取りの結果が残る）。
export async function extractExpenseAndSave(
  uploadId: string,
  fileDataBase64: string,
  fileType: string,
  fileName: string
): Promise<ExpenseExtractOutcome> {
  const outcome = await extractExpense(fileDataBase64, fileType, fileName)
  const failed = 'error' in outcome

  if (!failed) {
    // 読み取り直したときに前回の行が残って二重に並ばないよう、入れ直す前に消す。
    await db.delete(expenseUploadItems).where(eq(expenseUploadItems.upload_id, uploadId))
    // sort_order には原本の並び順をそのまま入れる。日付が読めない行があっても
    // 画面が原本と同じ順で出せるようにするため。
    await db.insert(expenseUploadItems).values(
      outcome.items.map((item, index) => ({
        upload_id: uploadId,
        item_date: item.item_date,
        from_place: item.from_place,
        to_place: item.to_place,
        description: item.description,
        amount: item.amount,
        sort_order: index,
      }))
    )
  }

  await db
    .update(expenseUploads)
    .set({ extract_error: failed ? outcome.error : null })
    .where(eq(expenseUploads.id, uploadId))

  return outcome
}
