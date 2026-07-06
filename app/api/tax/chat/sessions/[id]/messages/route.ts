import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { taxAdviceEntries, taxChatMessages, taxChatSessions } from '@/lib/schema'
import { eq, asc } from 'drizzle-orm'
import { getGeminiClient } from '@/lib/gemini'

const SESSION_TITLE_MAX_LENGTH = 30

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
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
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

  let fullText = ''

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      try {
        const gemini = getGeminiClient()
        const model = gemini.getGenerativeModel({ model: 'gemini-2.0-flash' })
        const chat = model.startChat({
          systemInstruction: systemPrompt,
          history: geminiHistory,
        })
        const result = await chat.sendMessageStream(userContent)

        for await (const chunk of result.stream) {
          const text = chunk.text()
          if (text) {
            fullText += text
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`))
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'AI応答の生成に失敗しました。'
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`))
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
