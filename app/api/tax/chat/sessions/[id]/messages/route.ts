import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { getAnthropicClient } from '@/lib/anthropic'

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/tax/chat/sessions/[id]/messages'>
) {
  const { id } = await ctx.params
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('tax_chat_messages')
    .select('*')
    .eq('session_id', id)
    .order('created_at', { ascending: true })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data)
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

  const supabase = createAdminClient()

  const [{ data: entries }, { data: history }] = await Promise.all([
    supabase.from('tax_advice_entries').select('title, body').order('created_at', { ascending: true }),
    supabase.from('tax_chat_messages').select('role, content').eq('session_id', sessionId).order('created_at', { ascending: true }),
  ])

  const adviceContext = entries?.length
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

  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    ...(history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: userContent },
  ]

  const anthropic = getAnthropicClient()

  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages,
  })

  let fullText = ''

  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          const text = chunk.delta.text
          fullText += text
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ text })}\n\n`))
        }
      }
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()

      await supabase.from('tax_chat_messages').insert([
        { session_id: sessionId, role: 'user', content: userContent },
        { session_id: sessionId, role: 'assistant', content: fullText },
      ])
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
