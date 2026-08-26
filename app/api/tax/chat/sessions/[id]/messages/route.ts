import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { taxAdviceEntries, taxChatMessages, taxChatSessions } from '@/lib/schema'
import { eq, asc } from 'drizzle-orm'
import { getGeminiClient } from '@/lib/gemini'
import { GEMINI_MODEL_FALLBACKS, AI_REQUEST_MIN_TIMEOUT_MS } from '@/lib/config'
import {
  callAiWithRetry,
  createAiRetryBudget,
  effectiveRequestTimeoutMs,
  isAiBusyError,
  isTransientAiError,
  withAbortSignalTimeout,
} from '@/lib/ai-retry'

// 関数のタイムアウト上限（秒）。GeminiのストリーミングはAIの応答時間ぶん待つため、
// 既定の短いタイムアウトだと長い回答が途中で切れうる。Vercel の仕様上リテラルで指定する。
export const maxDuration = 60

const SESSION_TITLE_MAX_LENGTH = 30

// 失敗の理由を、利用者が次に何をすればよいか分かる文言に訳す。
// 混雑・クォータ超過だけ言い分けるのは、この2つだけが「待てば直る」＝利用者の側で
// 打つ手が変わる失敗だから。それ以外は原因を伝えても行動が変わらないので汎用の文言でよい。
function userFacingErrorMessage(err: unknown): string {
  if (isAiBusyError(err)) {
    return 'AIが混み合っています（無料枠の上限に達している可能性があります）。時間をおいて再度お試しください。'
  }
  // 生のSDKエラー（URLやステータスが並ぶ文面）はそのまま見せない。利用者には読めず、
  // 詳しい内容はサーバーログに残してある。
  return 'AI応答の生成中にエラーが発生しました。もう一度お試しください。'
}

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/tax/chat/sessions/[id]/messages'>
) {
  try {
    const { id } = await ctx.params
    const data = await db.select().from(taxChatMessages)
      .where(eq(taxChatMessages.session_id, id))
      .orderBy(asc(taxChatMessages.created_at))
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/tax/chat/sessions/[id]/messages'>
) {
  const { id: sessionId } = await ctx.params
  const body = await req.json()
  const userContent = body.content as string
  if (!userContent?.trim()) {
    return Response.json({ error: 'content is required' }, { status: 400 })
  }

  const [entries, history] = await Promise.all([
    db.select({ title: taxAdviceEntries.title, body: taxAdviceEntries.body })
      .from(taxAdviceEntries)
      .orderBy(asc(taxAdviceEntries.created_at)),
    db.select({ role: taxChatMessages.role, content: taxChatMessages.content })
      .from(taxChatMessages)
      .where(eq(taxChatMessages.session_id, sessionId))
      .orderBy(asc(taxChatMessages.created_at)),
  ])

  const isFirstMessage = history.length === 0

  // Geminiの呼び出し前にユーザーメッセージを保存し、失敗時も入力内容が失われないようにする
  await db.insert(taxChatMessages).values({ session_id: sessionId, role: 'user', content: userContent })

  if (isFirstMessage) {
    const title = userContent.trim().slice(0, SESSION_TITLE_MAX_LENGTH)
    await db.update(taxChatSessions).set({ title }).where(eq(taxChatSessions.id, sessionId))
  }

  const adviceContext = entries.length
    ? entries.map((e) => `【${e.title}】\n${e.body}`).join('\n\n')
    : '（蓄積アドバイスなし）'

  const systemPrompt = [
    'あなたは税務の専門家アシスタントです。',
    '以下の税理士アドバイスをコンテキストとして回答してください。',
    '',
    '--- 蓄積アドバイス ---',
    adviceContext,
    '---------------------',
    '',
    'アドバイスに記載のない事項は「記載なし」と断った上で一般論を回答してください。',
    '日本語で回答してください。',
  ].join('\n')

  const geminiHistory = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  // 1つのモデルで応答を開き、「本文が入った最初のチャンク」まで読み進めて返す。
  // ここを1回の試行の単位にしているのは、この時点ではまだ何もクライアントへ流していないため、
  // 失敗しても別のモデルで安全にやり直せるから（流し始めたあとの切り替えは二重表示になる）。
  async function openStream(modelName: string, timeoutMs: number) {
    return withAbortSignalTimeout(timeoutMs, async (signal) => {
      const model = getGeminiClient().getGenerativeModel({
        model: modelName,
        // systemInstruction は startChat ではなくここで渡す。文字列をAPIが求める形
        // （{ role, parts }）へ整える処理はSDKの getGenerativeModel の中にしかなく、
        // startChat 経由だと文字列がそのまま送られて必ず 400
        //（Invalid value at 'system_instruction'）で弾かれるため。
        systemInstruction: systemPrompt,
      })
      // 試行ごとにチャットを作り直すのは、SDKのChatSessionが送信のたびに内部の履歴を書き換えるため。
      // 使い回すと失敗した回の状態が次の試行へ持ち越される。
      const chat = model.startChat({ history: geminiHistory })
      // SDKの requestOptions.timeout ではなく signal を渡す理由は withAbortSignalTimeout のコメント参照
      //（timeout は本文の受信中でも fetch ごと切るため、長い回答が途中で途切れる）。
      const result = await chat.sendMessageStream(userContent, { signal })

      // 本文の無いチャンク（メタ情報だけ）が先に届くことがあるので、中身が入るまで読み進める。
      // for await を使わないのは、途中で break/return すると JavaScript が後片付けとして
      // ストリームを閉じてしまい、残りの本文を受け取れなくなるため。
      for (let chunk = await result.stream.next(); !chunk.done; chunk = await result.stream.next()) {
        const text = chunk.value.text()
        if (text) return { firstText: text, rest: result.stream }
      }
      // 本文が1文字も返らないまま終わったケース。空の回答を保存しても利用者は何も得られないので
      // 失敗として扱う。
      throw new Error('AIが空の応答を返しました。')
    })
  }

  let fullText = ''

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (payload: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))

      // 再試行とモデル切り替えを合わせた「全体の締め切り」。切り替えたぶん時間が延びて
      // このルートの maxDuration（60秒）を超えては本末転倒なので、モデルをまたいで1つの予算を使い回す。
      // ここで測るのは「最初の本文が届くまで」だけで、そのあとの本文の受信は締め切りの外。
      // 予算を使い切っても回答の途中で切られることはない。
      const budget = createAiRetryBudget()

      // 本文を1文字でもクライアントへ流したか。モデルを切り替えてよい境目はここ。
      // 切り替えると新しいモデルは回答を頭から作り直すので、流し始めたあとに切り替えると
      // 同じ回答が二重に画面へ出てしまう。だから切り替えは「最初の本文が届く前の失敗」に限る。
      let streamed = false
      let completed = false
      let lastError: unknown = null

      try {
        for (let index = 0; index < GEMINI_MODEL_FALLBACKS.length; index++) {
          const modelName = GEMINI_MODEL_FALLBACKS[index]

          // 1回あたりの制限時間は残り予算で頭打ちにする（理由は effectiveRequestTimeoutMs のコメント）。
          const timeoutMs = effectiveRequestTimeoutMs(budget)

          // 数秒しか残っていない状態で次の候補を叩いても、応答が返る前に打ち切られるだけ。
          // それより早く失敗理由を返したほうが、利用者は原因を追って送り直せる。
          if (index > 0 && timeoutMs < AI_REQUEST_MIN_TIMEOUT_MS) {
            console.warn(`[tax-chat] 残り時間が足りないため ${modelName} 以降は試しません（残り ${timeoutMs}ms）。`)
            break
          }

          try {
            // Gemini の混雑（503）・レート制限（429）は数秒おけば通ることが多いので、
            // まず同じモデルで数回やり直す。残りの候補数を渡しておくと、残り時間が少ないときに
            // 再試行が見送られ、別モデルへ移る時間が確保される。
            const opened = await callAiWithRetry(
              `tax-chat:${modelName}`,
              () => openStream(modelName, timeoutMs),
              {
                budget,
                fallbacksRemaining: GEMINI_MODEL_FALLBACKS.length - index - 1,
              }
            )
            // 1つ目で通ったのか、切り替えた結果として通ったのかを後から追えるように残す
            // （切り替えが常態化しているなら既定モデルの見直しどきだと分かる）。
            console.info(
              `[tax-chat] ${modelName} で応答の生成に成功しました（候補 ${index + 1}/${GEMINI_MODEL_FALLBACKS.length}）。`
            )

            streamed = true
            fullText += opened.firstText
            send({ text: opened.firstText })

            for (let chunk = await opened.rest.next(); !chunk.done; chunk = await opened.rest.next()) {
              const text = chunk.value.text()
              if (!text) continue
              fullText += text
              send({ text })
            }
            completed = true
            break
          } catch (err) {
            lastError = err
            console.error(`[tax-chat] ${modelName} で失敗しました:`, err)
            // すでに本文を流しているなら切り替えない（上記のとおり二重表示になるため）。
            // ここまでの分は下の finally で部分保存され、画面にも残る。
            if (streamed) break
            // 恒久的なエラー（400=入力不正、401=APIキー不正など）は別のモデルでも同じ結果になる。
            // 待たせるだけ無駄なので、その時点で失敗として理由を返す。
            if (!isTransientAiError(err)) break
          }
        }

        if (completed) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        } else {
          send({ error: userFacingErrorMessage(lastError) })
        }
      } catch (err) {
        console.error('[tax-chat] 応答の送出中に想定外のエラーが発生しました:', err)
        send({ error: userFacingErrorMessage(err) })
      } finally {
        controller.close()
        // ストリームが失敗しても、それまでに生成できた分は部分保存する
        if (fullText) {
          await db.insert(taxChatMessages).values({ session_id: sessionId, role: 'assistant', content: fullText })
        }
      }
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
