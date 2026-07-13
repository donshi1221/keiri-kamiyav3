'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import ErrorToast from '@/app/components/error-toast'
import type { Contractor, Client, Assignment } from '@/lib/schema'

type AssignmentWithRelations = Assignment & {
  contractors: Pick<Contractor, 'id' | 'name' | 'contractor_type'> | null
  clients: Pick<Client, 'id' | 'name'> | null
}

async function readErrorMessage(res: Response, fallback: string) {
  try {
    const data = await res.json()
    return typeof data?.error === 'string' ? data.error : fallback
  } catch {
    return fallback
  }
}

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
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <h2 className="text-base font-semibold mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────
export default function MasterPage() {
  const [tab, setTab] = useState<'contractor' | 'client'>('contractor')
  const [contractors, setContractors] = useState<Contractor[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [assignments, setAssignments] = useState<AssignmentWithRelations[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showError = useCallback((msg: string) => {
    setErrorMsg(msg)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => setErrorMsg(null), 5000)
  }, [])

  useEffect(() => () => { if (errorTimerRef.current) clearTimeout(errorTimerRef.current) }, [])

  const load = useCallback(async () => {
    try {
      const [c, cl, a] = await Promise.all([
        fetch('/api/master/contractors').then((r) => r.json()),
        fetch('/api/master/clients').then((r) => r.json()),
        fetch('/api/master/assignments').then((r) => r.json()),
      ])
      setContractors(c ?? [])
      setClients(cl ?? [])
      setAssignments(a ?? [])
    } catch {
      showError('データの読み込みに失敗しました。接続を確認して再読み込みしてください。')
    }
  }, [showError])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-6">
      {errorMsg && <ErrorToast message={errorMsg} onClose={() => setErrorMsg(null)} />}

      <h1 className="text-xl font-bold">マスタ管理</h1>
      <div className="flex gap-2 border-b">
        {(['contractor', 'client'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 px-1 text-sm border-b-2 transition-colors ${tab === t ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {t === 'contractor' ? '委託者' : 'クライアント'}
          </button>
        ))}
      </div>

      {tab === 'contractor' && (
        <ContractorTab contractors={contractors} assignments={assignments} clients={clients} onRefresh={load} onError={showError} />
      )}
      {tab === 'client' && (
        <ClientTab clients={clients} contractors={contractors} assignments={assignments} onRefresh={load} onError={showError} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────
// Contractor Tab
// ─────────────────────────────────────────────
function ContractorTab({ contractors, assignments, clients, onRefresh, onError }: {
  contractors: Contractor[]
  assignments: AssignmentWithRelations[]
  clients: Client[]
  onRefresh: () => void
  onError: (msg: string) => void
}) {
  const [addOpen, setAddOpen] = useState(false)
  const [editContractor, setEditContractor] = useState<Contractor | null>(null)
  const [addAssignOpen, setAddAssignOpen] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Contractor | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<{ id: string; label: string } | null>(null)

  async function confirmDeleteContractor() {
    if (!deleteTarget) return
    const id = deleteTarget.id
    setDeleteTarget(null)
    try {
      const res = await fetch(`/api/master/contractors/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        onError(await readErrorMessage(res, '委託者の削除に失敗しました。'))
        return
      }
      onRefresh()
    } catch {
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  async function deactivateAssignment(id: string) {
    try {
      const res = await fetch(`/api/master/assignments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      })
      if (!res.ok) {
        onError(await readErrorMessage(res, 'アサインの非アクティブ化に失敗しました。'))
        return
      }
      onRefresh()
    } catch {
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  async function deleteAssignment(id: string, label: string) {
    try {
      const res = await fetch(`/api/master/assignments/${id}`, { method: 'DELETE' })
      if (res.status === 409) {
        const data = await res.json().catch(() => null)
        if (data?.hint === 'inactive') {
          setDeactivateTarget({ id, label })
          return
        }
        onError(data?.error ?? '削除できませんでした。')
        return
      }
      if (!res.ok) {
        onError(await readErrorMessage(res, 'アサインの削除に失敗しました。'))
        return
      }
      onRefresh()
    } catch {
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}>+ 委託者を追加</Button>
      </div>

      {contractors.length === 0 ? (
        <p className="text-sm text-gray-400">委託者が登録されていません</p>
      ) : (
        contractors.map((c) => {
          const myAssignments = assignments.filter((a) => a.contractor_id === c.id)
          return (
            <div key={c.id} className="rounded-lg border bg-white">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b">
                <span className="font-medium flex-1 min-w-[8rem]">{c.name}</span>
                <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                  {c.contractor_type === 'daiko' ? '代行者' : '動画編集者'}
                </span>
                {c.email && <span className="text-xs text-gray-400">{c.email}</span>}
                <button onClick={() => setEditContractor(c)} className="text-xs text-info hover:underline">編集</button>
                <button onClick={() => setDeleteTarget(c)} className="text-xs text-destructive hover:underline">削除</button>
              </div>
              <div className="px-4 py-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-500 font-medium">アサイン</span>
                  <button
                    onClick={() => setAddAssignOpen(c.id)}
                    className="text-xs text-info hover:underline"
                  >
                    + アサインを追加
                  </button>
                </div>
                {myAssignments.length === 0 ? (
                  <p className="text-xs text-gray-400 py-1">なし</p>
                ) : (
                  <div className="space-y-1">
                    {myAssignments.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 text-sm">
                        <span className={`flex-1 ${!a.active ? 'text-gray-400 line-through' : ''}`}>
                          {a.clients?.name} — {a.role_name}
                          {a.contractor_payout_amount > 0 && ` ¥${a.contractor_payout_amount.toLocaleString()}`}
                        </span>
                        {a.active && (
                          <button onClick={() => deleteAssignment(a.id, `${a.clients?.name ?? ''} — ${a.role_name}`)} className="text-xs text-danger hover:underline">削除</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })
      )}

      <ContractorFormDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => { setAddOpen(false); onRefresh() }}
        onError={onError}
        initial={null}
      />
      <ContractorFormDialog
        open={!!editContractor}
        onClose={() => setEditContractor(null)}
        onSaved={() => { setEditContractor(null); onRefresh() }}
        onError={onError}
        initial={editContractor}
      />
      {addAssignOpen && (
        <AssignFormDialog
          open={!!addAssignOpen}
          onClose={() => setAddAssignOpen(null)}
          onSaved={() => { setAddAssignOpen(null); onRefresh() }}
          onError={onError}
          clients={clients}
          contractors={[]}
          fixedContractorId={addAssignOpen}
          fixedContractorType={contractors.find((c) => c.id === addAssignOpen)?.contractor_type ?? 'daiko'}
          initial={null}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>委託者を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.name}」を削除します。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDeleteContractor}>削除する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deactivateTarget} onOpenChange={(open) => { if (!open) setDeactivateTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>削除できません</AlertDialogTitle>
            <AlertDialogDescription>
              「{deactivateTarget?.label}」は月次記録が存在するため削除できません。代わりに非アクティブにしますか？（過去の記録は残ります）
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deactivateTarget) deactivateAssignment(deactivateTarget.id)
                setDeactivateTarget(null)
              }}
            >
              非アクティブにする
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─────────────────────────────────────────────
// Client Tab
// ─────────────────────────────────────────────
function ClientTab({ clients, contractors, assignments, onRefresh, onError }: {
  clients: Client[]
  contractors: Contractor[]
  assignments: AssignmentWithRelations[]
  onRefresh: () => void
  onError: (msg: string) => void
}) {
  const [addClientOpen, setAddClientOpen] = useState(false)
  const [editClient, setEditClient] = useState<Client | null>(null)
  const [addAssignOpen, setAddAssignOpen] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<{ id: string; label: string } | null>(null)

  async function confirmDeleteClient() {
    if (!deleteTarget) return
    const id = deleteTarget.id
    setDeleteTarget(null)
    try {
      const res = await fetch(`/api/master/clients/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        onError(await readErrorMessage(res, 'クライアントの削除に失敗しました。'))
        return
      }
      onRefresh()
    } catch {
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  async function deactivateAssignment(id: string) {
    try {
      const res = await fetch(`/api/master/assignments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      })
      if (!res.ok) {
        onError(await readErrorMessage(res, 'アサインの非アクティブ化に失敗しました。'))
        return
      }
      onRefresh()
    } catch {
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  async function deleteAssignment(id: string, label: string) {
    try {
      const res = await fetch(`/api/master/assignments/${id}`, { method: 'DELETE' })
      if (res.status === 409) {
        const data = await res.json().catch(() => null)
        if (data?.hint === 'inactive') {
          setDeactivateTarget({ id, label })
          return
        }
        onError(data?.error ?? '削除できませんでした。')
        return
      }
      if (!res.ok) {
        onError(await readErrorMessage(res, 'アサインの削除に失敗しました。'))
        return
      }
      onRefresh()
    } catch {
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddClientOpen(true)}>+ クライアントを追加</Button>
      </div>

      {clients.length === 0 ? (
        <p className="text-sm text-gray-400">クライアントが登録されていません</p>
      ) : (
        clients.map((cl) => {
          const myAssignments = assignments.filter((a) => a.client_id === cl.id)
          return (
            <div key={cl.id} className="rounded-lg border bg-white">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b">
                <span className="font-medium flex-1 min-w-[8rem]">{cl.name}</span>
                {cl.billing_amount > 0 && (
                  <span className="text-sm text-gray-600">¥{cl.billing_amount.toLocaleString()}</span>
                )}
                {cl.contract_months && (
                  <span className="text-xs text-gray-400">{cl.contract_months}ヶ月</span>
                )}
                <button onClick={() => setEditClient(cl)} className="text-xs text-info hover:underline">編集</button>
                <button onClick={() => setDeleteTarget(cl)} className="text-xs text-destructive hover:underline">削除</button>
              </div>
              <div className="px-4 py-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-500 font-medium">アサイン</span>
                  <button onClick={() => setAddAssignOpen(cl.id)} className="text-xs text-info hover:underline">
                    + アサインを追加
                  </button>
                </div>
                {myAssignments.length === 0 ? (
                  <p className="text-xs text-gray-400 py-1">なし</p>
                ) : (
                  <div className="space-y-1">
                    {myAssignments.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 text-sm">
                        <span className={`flex-1 ${!a.active ? 'text-gray-400 line-through' : ''}`}>
                          {a.contractors?.name} — {a.role_name}
                          {a.contractor_payout_amount > 0 && ` ¥${a.contractor_payout_amount.toLocaleString()}`}
                        </span>
                        {a.active && (
                          <button onClick={() => deleteAssignment(a.id, `${a.contractors?.name ?? ''} — ${a.role_name}`)} className="text-xs text-danger hover:underline">削除</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })
      )}

      <ClientFormDialog
        open={addClientOpen}
        onClose={() => setAddClientOpen(false)}
        onSaved={() => { setAddClientOpen(false); onRefresh() }}
        onError={onError}
        initial={null}
      />
      <ClientFormDialog
        open={!!editClient}
        onClose={() => setEditClient(null)}
        onSaved={() => { setEditClient(null); onRefresh() }}
        onError={onError}
        initial={editClient}
      />
      {addAssignOpen && (
        <AssignFormDialog
          open={!!addAssignOpen}
          onClose={() => setAddAssignOpen(null)}
          onSaved={() => { setAddAssignOpen(null); onRefresh() }}
          onError={onError}
          clients={[]}
          contractors={contractors}
          fixedClientId={addAssignOpen}
          initial={null}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>クライアントを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.name}」を削除します。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDeleteClient}>削除する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deactivateTarget} onOpenChange={(open) => { if (!open) setDeactivateTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>削除できません</AlertDialogTitle>
            <AlertDialogDescription>
              「{deactivateTarget?.label}」は月次記録が存在するため削除できません。代わりに非アクティブにしますか？（過去の記録は残ります）
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deactivateTarget) deactivateAssignment(deactivateTarget.id)
                setDeactivateTarget(null)
              }}
            >
              非アクティブにする
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─────────────────────────────────────────────
// Contractor Form Dialog
// ─────────────────────────────────────────────
function ContractorFormDialog({ open, onClose, onSaved, onError, initial }: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  onError: (msg: string) => void
  initial: Contractor | null
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [contractorType, setContractorType] = useState<'daiko' | 'video_editor'>('daiko')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '')
      setEmail(initial?.email ?? '')
      setContractorType(initial?.contractor_type ?? 'daiko')
    }
  }, [open, initial])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = initial
        ? await fetch(`/api/master/contractors/${initial.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email: email || null, contractor_type: contractorType }),
          })
        : await fetch('/api/master/contractors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email: email || null, contractor_type: contractorType }),
          })
      setSaving(false)
      if (!res.ok) {
        onError(await readErrorMessage(res, '委託者の保存に失敗しました。'))
        return
      }
      onSaved()
    } catch {
      // 通信断でも fetch は例外になる。setSaving を戻さないと「保存中…」で固着する。
      setSaving(false)
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={initial ? '委託者を編集' : '委託者を追加'}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="text-sm font-medium block mb-1">名前 <span className="text-destructive">*</span></label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">種別</label>
          <select value={contractorType} onChange={(e) => setContractorType(e.target.value as 'daiko' | 'video_editor')} className="w-full border rounded px-3 py-2 text-sm">
            <option value="daiko">代行者</option>
            <option value="video_editor">動画編集者</option>
          </select>
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">メール</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" type="button" onClick={onClose}>キャンセル</Button>
          <Button size="sm" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </form>
    </Dialog>
  )
}

// ─────────────────────────────────────────────
// Client Form Dialog
// ─────────────────────────────────────────────
function ClientFormDialog({ open, onClose, onSaved, onError, initial }: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  onError: (msg: string) => void
  initial: Client | null
}) {
  const [name, setName] = useState('')
  const [billingAmount, setBillingAmount] = useState('')
  const [contractStart, setContractStart] = useState('')
  const [contractMonths, setContractMonths] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '')
      setBillingAmount(initial?.billing_amount?.toString() ?? '')
      setContractStart(initial?.contract_start ?? '')
      setContractMonths(initial?.contract_months?.toString() ?? '')
    }
  }, [open, initial])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const payload = {
      name,
      billing_amount: billingAmount ? Number(billingAmount) : 0,
      contract_start: contractStart || null,
      contract_months: contractMonths ? Number(contractMonths) : null,
    }
    try {
      const res = initial
        ? await fetch(`/api/master/clients/${initial.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/master/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
      setSaving(false)
      if (!res.ok) {
        onError(await readErrorMessage(res, 'クライアントの保存に失敗しました。'))
        return
      }
      onSaved()
    } catch {
      setSaving(false)
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={initial ? 'クライアントを編集' : 'クライアントを追加'}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="text-sm font-medium block mb-1">名前 <span className="text-destructive">*</span></label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">請求額</label>
          <input type="number" inputMode="numeric" value={billingAmount} onChange={(e) => setBillingAmount(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" placeholder="0" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium block mb-1">契約開始月</label>
            <input type="month" value={contractStart} onChange={(e) => setContractStart(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">契約期間（月）</label>
            <input type="number" inputMode="numeric" value={contractMonths} onChange={(e) => setContractMonths(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" placeholder="なし" min="1" />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" type="button" onClick={onClose}>キャンセル</Button>
          <Button size="sm" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </form>
    </Dialog>
  )
}

// ─────────────────────────────────────────────
// Assign Form Dialog
// ─────────────────────────────────────────────
function AssignFormDialog({ open, onClose, onSaved, onError, clients, contractors, fixedContractorId, fixedContractorType, fixedClientId, initial }: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  onError: (msg: string) => void
  clients: Client[]
  contractors: Contractor[]
  fixedContractorId?: string
  fixedContractorType?: 'daiko' | 'video_editor'
  fixedClientId?: string
  initial: Assignment | null
}) {
  const [contractorId, setContractorId] = useState(fixedContractorId ?? '')
  const [clientId, setClientId] = useState(fixedClientId ?? '')
  const [roleName, setRoleName] = useState('')
  const [payoutAmount, setPayoutAmount] = useState('')
  const [spreadsheetUrl, setSpreadsheetUrl] = useState('')
  const [saving, setSaving] = useState(false)

  const selectedContractorType = fixedContractorType
    ?? contractors.find((c) => c.id === contractorId)?.contractor_type
    ?? 'daiko'

  const isVideoEditor = selectedContractorType === 'video_editor'

  const dialogTitle = fixedContractorId
    ? `アサインを追加（${isVideoEditor ? '動画編集者' : '代行者'}）`
    : contractorId
      ? `アサインを追加（${isVideoEditor ? '動画編集者' : '代行者'}）`
      : 'アサインを追加'

  useEffect(() => {
    if (open) {
      setContractorId(fixedContractorId ?? initial?.contractor_id ?? '')
      setClientId(fixedClientId ?? initial?.client_id ?? '')
      setRoleName(initial?.role_name ?? '')
      setPayoutAmount(initial?.contractor_payout_amount?.toString() ?? '')
      setSpreadsheetUrl(initial?.spreadsheet_url ?? '')
    }
  }, [open, initial, fixedContractorId, fixedClientId])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const payload = {
      contractor_id: contractorId,
      client_id: clientId,
      role_name: isVideoEditor ? '動画編集' : roleName,
      contractor_payout_amount: isVideoEditor ? 0 : (payoutAmount ? Number(payoutAmount) : 0),
      spreadsheet_url: isVideoEditor ? (spreadsheetUrl || null) : null,
    }
    try {
      const res = await fetch('/api/master/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setSaving(false)
      if (!res.ok) {
        onError(await readErrorMessage(res, 'アサインの保存に失敗しました。'))
        return
      }
      onSaved()
    } catch {
      setSaving(false)
      onError('通信に失敗しました。接続を確認して再度お試しください。')
    }
  }

  const daikoContractors = contractors.filter((c) => c.contractor_type === 'daiko')
  const videoEditorContractors = contractors.filter((c) => c.contractor_type === 'video_editor')

  return (
    <Dialog open={open} onClose={onClose} title={dialogTitle}>
      <form onSubmit={submit} className="space-y-4">
        {!fixedContractorId && (
          <div>
            <label className="text-sm font-medium block mb-1">委託者 <span className="text-destructive">*</span></label>
            <select required value={contractorId} onChange={(e) => setContractorId(e.target.value)} className="w-full border rounded px-3 py-2 text-sm">
              <option value="">選択してください</option>
              {daikoContractors.length > 0 && (
                <optgroup label="代行者">
                  {daikoContractors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              )}
              {videoEditorContractors.length > 0 && (
                <optgroup label="動画編集者">
                  {videoEditorContractors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              )}
            </select>
          </div>
        )}

        {!fixedClientId && (
          <div>
            <label className="text-sm font-medium block mb-1">クライアント <span className="text-destructive">*</span></label>
            <select required value={clientId} onChange={(e) => setClientId(e.target.value)} className="w-full border rounded px-3 py-2 text-sm">
              <option value="">選択してください</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        <div className={`transition-opacity duration-150 ${isVideoEditor ? 'opacity-0 h-0 overflow-hidden' : 'opacity-100'}`}>
          <label className="text-sm font-medium block mb-1">役割名 <span className="text-destructive">*</span></label>
          <input value={roleName} onChange={(e) => setRoleName(e.target.value)} required={!isVideoEditor} className="w-full border rounded px-3 py-2 text-sm" placeholder="例: ライター" />
        </div>

        {isVideoEditor && (
          <div>
            <label className="text-sm font-medium block mb-1 text-gray-400">役割名: 動画編集（自動設定）</label>
          </div>
        )}

        <div className={`transition-opacity duration-150 ${isVideoEditor ? 'opacity-0 h-0 overflow-hidden' : 'opacity-100'}`}>
          <label className="text-sm font-medium block mb-1">報酬額</label>
          <input type="number" inputMode="numeric" value={payoutAmount} onChange={(e) => setPayoutAmount(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" placeholder="0" />
        </div>

        <div className={`transition-opacity duration-150 ${isVideoEditor ? 'opacity-100' : 'opacity-0 h-0 overflow-hidden'}`}>
          <label className="text-sm font-medium block mb-1">スプレッドシートURL</label>
          <input type="url" value={spreadsheetUrl} onChange={(e) => setSpreadsheetUrl(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" placeholder="https://docs.google.com/..." />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" type="button" onClick={onClose}>キャンセル</Button>
          <Button size="sm" type="submit" disabled={saving || !contractorId || !clientId}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
