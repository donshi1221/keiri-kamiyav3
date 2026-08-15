'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FormDialog } from './form-dialog'
import type { InvoiceReminderPlan, InvoiceReminderSendResult } from '@/lib/ui-types'

// 請求書が未受領の委託者へ、Chatworkで催促を送るダイアログ。
// 送信は「送信」を押したときの1回だけで、自動送信・定期送信は行わない
// （催促は相手のある行為なので、送る/送らないの判断を人の手に残す）。
// 文面のプレースホルダ（{name} {month} {url}）はサーバーが送信時に置き換えるため、
// ここでは置換せず、そのまま見せて編集させる（URLを人が触らずに済む）。
export default function InvoiceReminderDialog({ open, year, month, onClose }: {
  open: boolean
  year: number
  month: number
  onClose: () => void
}) {
  const [plan, setPlan] = useState<InvoiceReminderPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [template, setTemplate] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [results, setResults] = useState<InvoiceReminderSendResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 開くたびに対象者を取り直す。表を操作して受領チェックを付けた直後でも、
  // 画面に残った古い一覧に向けて催促を送ってしまわないようにする。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setPlan(null)
    setResults(null)
    setError(null)
    ;(async () => {
      try {
        const res = await fetch(`/api/invoice-reminder?year=${year}&month=${month}`, { cache: 'no-store' })
        const data = (await res.json().catch(() => null)) as (InvoiceReminderPlan & { error?: string }) | null
        if (!res.ok || !data) throw new Error(data?.error ?? '対象者の取得に失敗しました。')
        if (cancelled) return
        setPlan(data)
        setTemplate(data.template)
        // ルームID未登録の人は送りようがないので、初期選択から外す。
        setSelected(data.targets.filter((t) => t.hasRoomId).map((t) => t.contractorId))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '対象者の取得に失敗しました。')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, year, month])

  function toggle(contractorId: string) {
    setSelected((prev) =>
      prev.includes(contractorId) ? prev.filter((id) => id !== contractorId) : [...prev, contractorId]
    )
  }

  async function send() {
    if (selected.length === 0 || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch('/api/invoice-reminder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, contractorIds: selected, template }),
      })
      const data = (await res.json().catch(() => null)) as
        | { results?: InvoiceReminderSendResult[]; error?: string }
        | null
      if (!res.ok || !data?.results) throw new Error(data?.error ?? 'リマインドの送信に失敗しました。')
      setResults(data.results)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'リマインドの送信に失敗しました。')
    } finally {
      setSending(false)
    }
  }

  const targets = plan?.targets ?? []
  const sendable = targets.filter((t) => t.hasRoomId).length

  return (
    <FormDialog open={open} onClose={onClose} title="請求書の未提出リマインド" maxWidth="max-w-lg">
      <div className="space-y-4">
        {loading && <p className="text-sm text-muted-foreground">対象者を確認しています…</p>}
        {error && (
          <p className="rounded border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-danger">{error}</p>
        )}

        {/* 送信後は結果だけを見せる。同じ画面に送信ボタンを残すと二重送信につながるため。 */}
        {results ? (
          <>
            <ul className="space-y-1">
              {results.map((r) => (
                <li key={r.contractorId} className="text-sm">
                  {r.status === 'sent' ? (
                    <span className="text-success">✓ {r.name} 送信済み</span>
                  ) : (
                    <span className="text-danger">
                      ✗ {r.name}
                      <span className="ml-1 text-muted-foreground">{r.message}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex justify-end pt-2">
              <Button size="sm" className="h-11 md:h-7" type="button" onClick={onClose}>閉じる</Button>
            </div>
          </>
        ) : plan && (
          <>
            <p className="text-sm text-muted-foreground">
              {plan.invoiceYear}年{plan.invoiceMonth}月分の請求書がまだ受領できていない委託者です。
            </p>

            {targets.length === 0 ? (
              <p className="text-sm text-muted-foreground">未提出の委託者はいません。</p>
            ) : (
              <ul className="space-y-1">
                {targets.map((t) => {
                  const checked = selected.includes(t.contractorId)
                  return (
                    <li key={t.contractorId}>
                      {/* チェックボックス本体ではなく行全体を押せるようにする（スマホで44pxのタップ領域を確保）。
                          Checkbox は見た目だけの役割にして、状態はこのボタンが持つ。 */}
                      <button
                        type="button"
                        disabled={!t.hasRoomId}
                        onClick={() => toggle(t.contractorId)}
                        aria-pressed={checked}
                        className={`flex min-h-11 w-full items-center gap-3 rounded px-2 text-left text-sm md:min-h-9 ${
                          t.hasRoomId ? 'text-foreground hover:bg-accent' : 'cursor-not-allowed text-muted-foreground'
                        }`}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={!t.hasRoomId}
                          className="pointer-events-none"
                          tabIndex={-1}
                        />
                        <span>{t.name}</span>
                        {!t.hasRoomId && (
                          <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                            ルームID未登録
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            {sendable > 0 && (
              <div>
                <label htmlFor="reminder-template" className="mb-1 block text-sm font-medium">文面</label>
                <textarea
                  id="reminder-template"
                  rows={6}
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  className="w-full rounded border px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {'{name}'} は名前、{'{month}'} は対象月、{'{url}'} は受付URLに置き換わります。
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" className="h-11 md:h-7" type="button" onClick={onClose}>
                キャンセル
              </Button>
              <Button
                size="sm"
                className="h-11 md:h-7"
                type="button"
                onClick={send}
                disabled={sending || selected.length === 0 || !template.trim()}
              >
                {sending ? '送信中…' : `送信（${selected.length}名）`}
              </Button>
            </div>
          </>
        )}
      </div>
    </FormDialog>
  )
}
