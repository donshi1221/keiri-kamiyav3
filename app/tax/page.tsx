'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import type { TaxAdviceEntry, TaxChatSession, TaxChatMessage } from '@/lib/schema'
import ErrorToast from '@/app/components/error-toast'

// ─────────────────────────────────────────────
// Dialog
// ─────────────────────────────────────────────
function Dialog({ open, onClose, title, children }: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}) {
  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
        <h2 className="text-base font-semibold mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
export default function TaxPage() {
  const [entries, setEntries] = useState<TaxAdviceEntry[]>([])
  const [sessions, setSessions] = useState<TaxChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<TaxChatMessage[]>([])
  const [addTextOpen, setAddTextOpen] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<'advice' | 'chat'>('chat')

  const loadEntries = useCallback(async () => {
    const data = await fetch('/api/tax/advice').then((r) => r.json())
    setEntries(data ?? [])
  }, [])

  const loadSessions = useCallback(async () => {
    const data = await fetch('/api/tax/chat/sessions').then((r) => r.json())
    setSessions(data ?? [])
    if (!activeSessionId && data?.length > 0) setActiveSessionId(data[0].id)
  }, [activeSessionId])

  useEffect(() => {
    loadEntries()
    loadSessions()
  }, [loadEntries, loadSessions])

  useEffect(() => {
    if (!activeSessionId) { setMessages([]); return }
    fetch(`/api/tax/chat/sessions/${activeSessionId}/messages`)
      .then((r) => r.json())
      .then((data) => setMessages(data ?? []))
  }, [activeSessionId])

  async function deleteEntry(id: string) {
    if (!confirm('このエントリを削除しますか？')) return
    await fetch(`/api/tax/advice/${id}`, { method: 'DELETE' })
    loadEntries()
  }

  async function newSession() {
    const data = await fetch('/api/tax/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '新しい会話' }),
    }).then((r) => r.json())
    setSessions((prev) => [data, ...prev])
    setActiveSessionId(data.id)
    setMessages([])
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">税務メモ</h1>

      {/* スマホ表示（md未満）: パネル切替タブ */}
      <div className="mb-3 flex gap-2 border-b md:hidden">
        <button
          type="button"
          onClick={() => setMobilePanel('advice')}
          className={`pb-2 px-1 text-sm border-b-2 transition-colors ${mobilePanel === 'advice' ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500'}`}
        >
          アドバイス管理
        </button>
        <button
          type="button"
          onClick={() => setMobilePanel('chat')}
          className={`pb-2 px-1 text-sm border-b-2 transition-colors ${mobilePanel === 'chat' ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500'}`}
        >
          AIチャット
        </button>
      </div>

      <div className="flex flex-col gap-6 h-[calc(100dvh-260px)] md:h-[calc(100dvh-160px)] md:flex-row">
        {/* 左パネル: アドバイス管理 */}
        <div className={`w-full shrink-0 flex-col gap-3 md:flex md:w-72 ${mobilePanel === 'advice' ? 'flex' : 'hidden'}`}>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="flex-1" onClick={() => setAddTextOpen(true)}>
              + テキスト追加
            </Button>
            <label className="flex-1 inline-flex items-center justify-center rounded-md border border-input bg-background text-sm font-medium h-8 px-3 py-1 cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors">
              ↑ ファイル
              <input
                type="file"
                accept=".pdf,.txt,.md"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const form = new FormData()
                  form.append('file', file)
                  await fetch('/api/tax/advice/upload', { method: 'POST', body: form })
                  loadEntries()
                  e.target.value = ''
                }}
              />
            </label>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2">
            {entries.length === 0 ? (
              <p className="text-sm text-gray-400">アドバイスが登録されていません</p>
            ) : (
              entries.map((e) => (
                <div key={e.id} className="rounded-lg border bg-white p-3 text-sm">
                  <div className="flex items-start gap-1">
                    <span className="shrink-0">{e.source_type === 'file' ? '📎' : '📄'}</span>
                    <span className="flex-1 font-medium line-clamp-2 break-all">{e.title}</span>
                    <button onClick={() => deleteEntry(e.id)} className="text-danger hover:text-danger shrink-0 ml-1">×</button>
                  </div>
                  <div className="text-xs text-gray-400 mt-1 ml-5">
                    {new Date(e.created_at).toLocaleDateString('ja-JP')}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 右パネル: AIチャット */}
        <div className={`flex-1 flex-col min-w-0 md:flex ${mobilePanel === 'chat' ? 'flex' : 'hidden'}`}>
          <div className="flex items-center gap-2 mb-3">
            <Button size="sm" onClick={newSession}>新しい会話</Button>
            {sessions.length > 0 && (
              <select
                value={activeSessionId ?? ''}
                onChange={(e) => setActiveSessionId(e.target.value)}
                className="flex-1 border rounded px-3 py-1.5 text-sm"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} — {new Date(s.created_at).toLocaleDateString('ja-JP')}
                  </option>
                ))}
              </select>
            )}
          </div>

          {activeSessionId ? (
            <ChatPanel
              sessionId={activeSessionId}
              messages={messages}
              streaming={streaming}
              setMessages={setMessages}
              setStreaming={setStreaming}
              onFirstMessageSent={loadSessions}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400 border rounded-lg">
              「新しい会話」をクリックしてチャットを開始してください
            </div>
          )}
        </div>
      </div>

      <AddTextDialog
        open={addTextOpen}
        onClose={() => setAddTextOpen(false)}
        onSaved={() => { setAddTextOpen(false); loadEntries() }}
      />
    </div>
  )
}

// ─────────────────────────────────────────────
// Chat Panel
// ─────────────────────────────────────────────
function ChatPanel({ sessionId, messages, streaming, setMessages, setStreaming, onFirstMessageSent }: {
  sessionId: string
  messages: TaxChatMessage[]
  streaming: boolean
  setMessages: React.Dispatch<React.SetStateAction<TaxChatMessage[]>>
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>
  onFirstMessageSent: () => void
}) {
  const [input, setInput] = useState('')
  const [streamingText, setStreamingText] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  async function send() {
    const content = input.trim()
    if (!content || streaming) return
    const isFirstMessage = messages.length === 0
    setInput('')
    setErrorMsg(null)
    setMessages((prev) => [...prev, { id: 'tmp', session_id: sessionId, role: 'user', content, created_at: new Date().toISOString() }])
    setStreaming(true)
    setStreamingText('')

    const res = await fetch(`/api/tax/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })

    if (!res.body) {
      setStreaming(false)
      setErrorMsg('AI応答の取得に失敗しました。もう一度お試しください。')
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let full = ''
    let streamError: string | null = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6)
        if (payload === '[DONE]') break
        try {
          const { text, error } = JSON.parse(payload)
          if (error) {
            streamError = error
          } else if (text) {
            full += text
            setStreamingText(full)
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    setStreaming(false)
    setStreamingText('')
    if (full) {
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), session_id: sessionId, role: 'assistant', content: full, created_at: new Date().toISOString() },
      ])
    }
    if (streamError) {
      setErrorMsg('AI応答の生成中にエラーが発生しました。もう一度お試しください。')
    }
    if (isFirstMessage) {
      onFirstMessageSent()
    }
  }

  return (
    <div className="flex-1 flex flex-col border rounded-lg overflow-hidden">
      {errorMsg && (
        <div className="p-2">
          <ErrorToast message={errorMsg} onClose={() => setErrorMsg(null)} />
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && !streaming && (
          <p className="text-sm text-gray-400 text-center mt-8">メッセージを送信してください</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${m.role === 'user' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-800'}`}>
              {m.content}
            </div>
          </div>
        ))}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-800 whitespace-pre-wrap">
              {streamingText || <span className="animate-pulse">…</span>}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t p-3 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() }}
          placeholder="メッセージを入力（Ctrl+Enter で送信）"
          rows={2}
          className="flex-1 resize-none border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
          disabled={streaming}
        />
        <Button size="sm" onClick={send} disabled={streaming || !input.trim()}>
          {streaming ? '…' : '送信'}
        </Button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// Add Text Dialog
// ─────────────────────────────────────────────
function AddTextDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { if (open) { setTitle(''); setBody('') } }, [open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    await fetch('/api/tax/advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    })
    setSaving(false)
    onSaved()
  }

  return (
    <Dialog open={open} onClose={onClose} title="アドバイスをテキストで追加">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="text-sm font-medium block mb-1">タイトル <span className="text-danger">*</span></label>
          <input required value={title} onChange={(e) => setTitle(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">内容 <span className="text-danger">*</span></label>
          <textarea required rows={6} value={body} onChange={(e) => setBody(e.target.value)} className="w-full border rounded px-3 py-2 text-sm resize-none" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" type="button" onClick={onClose}>キャンセル</Button>
          <Button size="sm" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </form>
    </Dialog>
  )
}
