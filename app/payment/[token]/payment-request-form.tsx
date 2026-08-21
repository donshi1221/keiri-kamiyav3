'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

async function readErrorMessage(res: Response, fallback: string) {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return typeof data?.error === 'string' ? data.error : fallback
}

// 代表向けの画面なので、読み取り結果も専門用語も出さない。
// 送るのは「請求書1枚＋任意のメモ」だけで、確認は経理が行う前提にしている
//（経費受付のように行ごとの割り当てを求めると、代表の手間が増えて依頼が滞るため）。
export default function PaymentRequestForm({ token }: { token: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || sending) return

    setSending(true)
    setError('')

    const body = new FormData()
    body.append('token', token)
    body.append('file', file)
    body.append('note', note)

    try {
      const res = await fetch('/api/payment-inbox', { method: 'POST', body })
      setSending(false)
      if (!res.ok) {
        setError(await readErrorMessage(res, '送信に失敗しました。時間をおいて再度お試しください。'))
        return
      }
      setDone(true)
    } catch {
      // 通信断でも fetch は例外になる。理由を返さないと「送信中…」の表示から抜けられない。
      setSending(false)
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  function reset() {
    setFile(null)
    setNote('')
    setDone(false)
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  if (done) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-success bg-success-subtle px-4 py-3 text-sm text-success">
          受け付けました。経理が確認します。
        </div>
        <Button type="button" variant="outline" className="h-11 w-full" onClick={reset}>
          続けて別の請求書を送る
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        振り込んでほしい請求書を1枚ずつ送ってください。PDFでも、スマートフォンで撮った写真でも大丈夫です。
      </p>

      <div>
        <label htmlFor="payment-file" className="mb-1 block text-sm font-medium">
          請求書（PDF・写真）
        </label>
        <input
          id="payment-file"
          ref={inputRef}
          type="file"
          accept="application/pdf,image/*"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setError('')
          }}
          className="w-full rounded border px-3 py-2.5 text-sm file:mr-3 file:min-h-11 file:rounded file:border-0 file:bg-primary file:px-3 file:text-sm file:text-primary-foreground"
        />
        {/* 端末によっては入力欄にファイル名が出ず、選び間違いに気付けない。送る前に名前を出しておく。 */}
        {file && <p className="mt-2 text-sm break-all">{file.name}</p>}
      </div>

      <div>
        <label htmlFor="payment-note" className="mb-1 block text-sm font-medium">
          メモ（任意）
        </label>
        <textarea
          id="payment-note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="支払期日や用途があればご記入ください"
          className="w-full rounded border bg-card px-3 py-2 text-sm"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <Button type="submit" className="h-11 w-full" disabled={!file || sending}>
        {sending ? '送信中…' : '送信する'}
      </Button>

      {/* 送信すると裏で内容の読み取りまで行うため十数秒かかることがある。
          何も出ないと固まったように見えて画面を閉じられてしまうため、待ち時間であることを明示する。 */}
      {sending && (
        <p className="text-center text-xs text-muted-foreground">
          送信しています。1分ほどかかることがあります。このまま画面を開いたままお待ちください。
        </p>
      )}
    </form>
  )
}
