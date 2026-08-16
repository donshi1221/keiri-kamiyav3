'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

export default function InvoiceUploadForm({ token }: { token: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [done, setDone] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    setError('')

    const body = new FormData()
    body.append('token', token)
    body.append('file', file)

    try {
      const res = await fetch('/api/invoice-inbox', { method: 'POST', body })
      setUploading(false)
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(typeof data?.error === 'string' ? data.error : 'アップロードに失敗しました。時間をおいて再度お試しください。')
        return
      }
      setDone(true)
    } catch {
      // 通信断でも fetch は例外になる。戻さないと「送信中…」でボタンが固着する。
      setUploading(false)
      setError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  function reset() {
    setFile(null)
    setDone(false)
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  if (done) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-success bg-success-subtle px-4 py-3 text-sm text-success">
          請求書を受け付けました。
        </div>
        <Button type="button" variant="outline" className="h-11 w-full" onClick={reset}>
          続けて別の請求書を送る
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted-foreground">請求書のPDFファイルを選んで送信してください。</p>

      <div className="rounded-lg border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-warning">
        <p className="font-medium">ご確認ください</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>請求書に「◯月分」を必ず記載してください（基本は前月分）</li>
          <li>ファイル名も記載の月と合わせていただくとスムーズです</li>
        </ul>
      </div>

      <div>
        <label htmlFor="invoice-file" className="mb-1 block text-sm font-medium">
          請求書ファイル（PDF）
        </label>
        <input
          id="invoice-file"
          ref={inputRef}
          type="file"
          accept="application/pdf"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setError('')
          }}
          className="w-full rounded border px-3 py-2.5 text-sm file:mr-3 file:min-h-11 file:rounded file:border-0 file:bg-primary file:px-3 file:text-sm file:text-primary-foreground"
        />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <Button type="submit" className="h-11 w-full" disabled={!file || uploading}>
        {uploading ? '送信中…' : '送信する'}
      </Button>
    </form>
  )
}
