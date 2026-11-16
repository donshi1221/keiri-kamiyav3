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
import { checkExpenseAmount } from '@/lib/expense-amount-check'
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
          breakdown_amount: {
            type: SchemaType.INTEGER,
            nullable: true,
            description: '領収証の内訳欄に書かれた金額（円）。内訳欄が無ければ null',
          },
          breakdown_tax: {
            type: SchemaType.INTEGER,
            nullable: true,
            description: '領収証の内訳欄に書かれた消費税額（円）。内訳欄が無ければ null',
          },
          breakdown_is_tax_included: {
            type: SchemaType.BOOLEAN,
            nullable: true,
            description: '内訳欄の金額が税込なら true、税抜なら false。判別できなければ null',
          },
        },
        // 内訳の3項目は required に入れない。ICOCAの利用履歴など内訳の無い書類が大半で、必須にすると
        // 既存の読み取りの答え方まで変わりうるため（今まで安定していた交通費の読み取りを崩さないことを優先）。
        required: ['item_date', 'from_place', 'to_place', 'description', 'amount'],
      },
    },
  },
  required: ['items'],
}

// 原本は「モバイルICOCAの1か月分の利用履歴PDF（明細10件前後）」「特急券などの領収書1枚」のほか、
// 社会保険料・税金の納付書のような支払済み書類でも届く。交通費だけを想定した指示だと
// 納付書で明細0件になり受付が止まるため、書類の種類ごとの返し方を分けて示す。
// 交通費は表の列名・レイアウトを具体的に示さないと、残額の列を利用額と取り違える。
const PROMPT = [
  'これは日本の経費・支払に関する書類です（交通費の利用履歴や領収書のほか、社会保険料・労働保険・税金の納付書などもあります）。',
  '書類の内容を読み取ってJSONで返してください。',
  '',
  '■ 交通費の書類（モバイルICOCAの利用履歴、特急券などの領収書）の場合',
  '利用明細を1行ずつ読み取る。',
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
  '',
  '■ 交通費以外の支払書類（社会保険料・労働保険・税金の納付書、その他の領収書）の場合',
  'その書類の支払内容を1行として返す。',
  '- item_date: 支払日。書かれていなければ発行日・納付期限など、その書類で読める日付を YYYY-MM-DD で返す。',
  '- from_place / to_place: 区間の無い書類なので必ず両方 null にする。',
  '- description: 何の支払かが分かる文字（例:「社会保険料 8月分」「法人税 中間納付」「事務用品」）。',
  '- amount: 支払金額（円）。カンマ・「円」を取り除いた正の整数で返す。',
  '合計金額が明確な書類は、内訳を無理に分解せず合計の1行だけ返してよい',
  '（健康保険・厚生年金などの内訳が並ぶ納付書は「合計額」の1行で十分）。',
  '',
  '■ 飲食店などの領収証（手書きのものを含む）の場合',
  '- 税込の合計金額を1行だけ返す。品目の内訳が書かれていても分解しない。',
  '- item_date: 日付欄の日付を YYYY-MM-DD で返す。日付欄が空欄なら推測せず null にする。',
  '- from_place / to_place: 区間の無い書類なので必ず両方 null にする。',
  '- description: 「店名 飲食代」のように、どこへの何の支払かが分かる文字（例:「○○食堂 飲食代」）。',
  '- amount: 手書きの金額が内訳（税抜金額・消費税額）と食い違って見えるときは、',
  '  大きく書かれた合計欄（「金額」「¥」の欄）の金額を優先する。',
  '  ただし手書きの「¥」は、横線の入った「7」や「ア」のような形に書かれることがあり、',
  '  先頭の「¥」を数字の7と読み違えやすい。金額の先頭にある通貨記号は数字に含めないこと。',
  '  （例: 手書きで「¥9,900」と書かれているのに「79,900」と読まない）',
  '  内訳が書かれているときは、税抜金額 + 消費税額 = 合計 になるかを検算し、',
  '  合計欄の読み取りが内訳と合わないときは、内訳から合うほうの金額を返す。',
  '- breakdown_amount / breakdown_tax / breakdown_is_tax_included:',
  '  領収証に「内訳（税率・金額（税抜／税込）・消費税額等）」の欄があるときだけ、',
  '  その欄の金額を breakdown_amount に、消費税額を breakdown_tax に、カンマ・「円」・「¥」を取り除いた整数で返す。',
  '  breakdown_is_tax_included は、内訳欄の金額が税込なら true、税抜なら false、',
  '  丸囲みが無いなどで判別できなければ null にする。',
  '  合計欄の amount とは別に、内訳欄に書かれている数字をそのまま読むこと（合計に合わせて辻褄を合わせない）。',
  '  内訳の税率の行が2行以上書かれている場合（8%の行と10%の行が並ぶなど）は、',
  '  breakdown_amount / breakdown_tax / breakdown_is_tax_included を3つとも null にする（1行目だけを返さない）。',
  '',
  '内訳欄が無い書類（交通費の書類・納付書・内訳の無い領収書）では、',
  'breakdown_amount / breakdown_tax / breakdown_is_tax_included の3つとも null にする。',
  '',
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

// 内訳欄の金額は検算にしか使わないため、読めなければ 0 でなく null にする。
// 0 にすると「0円の内訳」と区別できず、検算で誤った警告を出してしまう。
function normalizeBreakdownAmount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const n = Math.abs(Math.round(value))
  return n <= MAX_AMOUNT ? n : null
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
    const amount = normalizeAmount(item.amount)
    const normalized: ExpenseExtractedItem = {
      item_date: normalizeDate(item.item_date),
      from_place: normalizeText(item.from_place),
      to_place: normalizeText(item.to_place),
      description: normalizeText(item.description),
      amount,
      amount_check_note: checkExpenseAmount({
        amount,
        breakdown_amount: normalizeBreakdownAmount(item.breakdown_amount),
        breakdown_tax: normalizeBreakdownAmount(item.breakdown_tax),
        breakdown_is_tax_included:
          typeof item.breakdown_is_tax_included === 'boolean' ? item.breakdown_is_tax_included : null,
      }),
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
    return {
      error:
        '明細を読み取れませんでした（ファイルの内容をご確認ください）。画像がぼやけている・暗い、書類の一部が切れて写っていない、経費の書類ではない、などが考えられます。',
    }
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
        amount_check_note: item.amount_check_note,
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
