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
import { Plus, Trash2 } from 'lucide-react'
import type { Contractor, Client, Assignment, ClientBillingItem } from '@/lib/schema'

type AssignmentWithRelations = Assignment & {
  contractors: Pick<Contractor, 'id' | 'name' | 'contractor_type'> | null
  clients: Pick<Client, 'id' | 'name'> | null
}

// GET /api/master/clients はクライアントに請求内訳(billing_items)をぶら下げて返す。
type ClientWithItems = Client & { billing_items: ClientBillingItem[] }

// フォーム内で編集中の内訳1行。既存はid付き、新規追加はid未設定（保存時にPOSTで採番）。
type ItemDraft = {
  id?: string
  label: string
  billing_amount: string
  contract_start: string
  contract_months: string
  active: boolean
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
  const [clients, setClients] = useState<ClientWithItems[]>([])
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
  const [editAssign, setEditAssign] = useState<AssignmentWithRelations | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Contractor | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<{ id: string; label: string } | null>(null)
  const [deleteAssignTarget, setDeleteAssignTarget] = useState<{ id: string; label: string } | null>(null)

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
                {c.contractor_type === 'video_editor' && c.unit_price > 0 && (
                  <span className="text-xs text-gray-500">単価 ¥{c.unit_price.toLocaleString()}/本</span>
                )}
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
                    {myAssignments.map((a) => {
                      // 編集者のフル納品額 = 委託者の単価 × 担当クライアントの月本数。
                      // 保存はせず表示のたびに計算する（マスタ変更時の再計算漏れを防ぐ）。
                      const assignClient = clients.find((cl) => cl.id === a.client_id)
                      const videoCount = assignClient?.monthly_video_count ?? 0
                      const fullDelivery =
                        c.contractor_type === 'video_editor' && c.unit_price > 0 && videoCount > 0
                          ? c.unit_price * videoCount
                          : null
                      return (
                        <div key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className={`flex-1 min-w-[10rem] ${!a.active ? 'text-gray-400 line-through' : ''}`}>
                            {a.clients?.name} — {a.role_name}
                            {a.contractor_payout_amount > 0 && ` ¥${a.contractor_payout_amount.toLocaleString()}`}
                            {fullDelivery !== null && (
                              <span className="text-xs text-gray-500">
                                {' '}フル納品 ¥{fullDelivery.toLocaleString()}（¥{c.unit_price.toLocaleString()}×{videoCount}本）
                              </span>
                            )}
                            {(a.payment_start_month || a.payment_count) && (
                              <span className="block text-xs text-gray-500">
                                支払期間: {a.payment_start_month ? a.payment_start_month.slice(0, 7) : '設定なし'}から {a.payment_count ? `${a.payment_count}回` : '継続'}
                              </span>
                            )}
                          </span>
                          <button onClick={() => setEditAssign(a)} className="text-xs text-info hover:underline">編集</button>
                          {a.active && (
                            <button onClick={() => setDeleteAssignTarget({ id: a.id, label: `${a.clients?.name ?? ''} — ${a.role_name}` })} className="text-xs text-danger hover:underline">削除</button>
                          )}
                        </div>
                      )
                    })}
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
      {editAssign && (
        <AssignFormDialog
          open={!!editAssign}
          onClose={() => setEditAssign(null)}
          onSaved={() => { setEditAssign(null); onRefresh() }}
          onError={onError}
          clients={clients}
          contractors={[]}
          fixedContractorId={editAssign.contractor_id}
          fixedContractorType={contractors.find((c) => c.id === editAssign.contractor_id)?.contractor_type ?? 'daiko'}
          initial={editAssign}
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

      <AlertDialog open={!!deleteAssignTarget} onOpenChange={(open) => { if (!open) setDeleteAssignTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>アサインを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteAssignTarget?.label}」のアサインを削除します。月次記録が存在する場合は削除できず、非アクティブ化を案内します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteAssignTarget) deleteAssignment(deleteAssignTarget.id, deleteAssignTarget.label)
                setDeleteAssignTarget(null)
              }}
            >
              削除する
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
  clients: ClientWithItems[]
  contractors: Contractor[]
  assignments: AssignmentWithRelations[]
  onRefresh: () => void
  onError: (msg: string) => void
}) {
  const [addClientOpen, setAddClientOpen] = useState(false)
  const [editClient, setEditClient] = useState<ClientWithItems | null>(null)
  const [addAssignOpen, setAddAssignOpen] = useState<string | null>(null)
  const [editAssign, setEditAssign] = useState<AssignmentWithRelations | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<{ id: string; label: string } | null>(null)
  const [deleteAssignTarget, setDeleteAssignTarget] = useState<{ id: string; label: string } | null>(null)

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
          const items = cl.billing_items ?? []
          const activeItems = items.filter((it) => it.active)
          const totalBilling = activeItems.reduce((sum, it) => sum + it.billing_amount, 0)
          return (
            <div key={cl.id} className="rounded-lg border bg-white">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b">
                <span className="font-medium flex-1 min-w-[8rem]">{cl.name}</span>
                {cl.monthly_video_count > 0 && (
                  <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">月{cl.monthly_video_count}本</span>
                )}
                {totalBilling > 0 && (
                  <span className="text-sm text-gray-600">¥{totalBilling.toLocaleString()}</span>
                )}
                <button onClick={() => setEditClient(cl)} className="text-xs text-info hover:underline">編集</button>
                <button onClick={() => setDeleteTarget(cl)} className="text-xs text-destructive hover:underline">削除</button>
              </div>
              {/* 請求内訳の一覧（金額・契約期間・停止中を一目で確認） */}
              {items.length > 0 && (
                <div className="px-4 py-2 border-b bg-gray-50/50">
                  <div className="mb-1 text-xs font-medium text-gray-500">請求内訳</div>
                  <div className="space-y-1">
                    {items.map((it) => (
                      <div key={it.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className={`flex-1 min-w-[6rem] ${!it.active ? 'text-gray-400 line-through' : ''}`}>
                          {it.label || '（内訳名なし）'}
                        </span>
                        <span className={!it.active ? 'text-gray-400' : 'text-gray-600'}>
                          {it.billing_amount > 0 ? `¥${it.billing_amount.toLocaleString()}` : '—'}
                        </span>
                        {it.contract_start && (
                          <span className="text-xs text-gray-400">
                            {it.contract_start.slice(0, 7)}
                            {it.contract_months ? `〜${it.contract_months}ヶ月` : '〜'}
                          </span>
                        )}
                        {!it.active && <span className="text-xs text-gray-400">（停止中）</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
                    {myAssignments.map((a) => {
                      // 編集者のフル納品額 = 委託者の単価 × このクライアントの月本数（表示時に計算）。
                      const assignContractor = contractors.find((c) => c.id === a.contractor_id)
                      const unitPrice = assignContractor?.contractor_type === 'video_editor' ? assignContractor.unit_price : 0
                      const fullDelivery =
                        unitPrice > 0 && cl.monthly_video_count > 0 ? unitPrice * cl.monthly_video_count : null
                      return (
                        <div key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className={`flex-1 min-w-[10rem] ${!a.active ? 'text-gray-400 line-through' : ''}`}>
                            {a.contractors?.name} — {a.role_name}
                            {a.contractor_payout_amount > 0 && ` ¥${a.contractor_payout_amount.toLocaleString()}`}
                            {fullDelivery !== null && (
                              <span className="text-xs text-gray-500">
                                {' '}フル納品 ¥{fullDelivery.toLocaleString()}（¥{unitPrice.toLocaleString()}×{cl.monthly_video_count}本）
                              </span>
                            )}
                          </span>
                          <button onClick={() => setEditAssign(a)} className="text-xs text-info hover:underline">編集</button>
                          {a.active && (
                            <button onClick={() => setDeleteAssignTarget({ id: a.id, label: `${a.contractors?.name ?? ''} — ${a.role_name}` })} className="text-xs text-danger hover:underline">削除</button>
                          )}
                        </div>
                      )
                    })}
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
      {editAssign && (
        <AssignFormDialog
          open={!!editAssign}
          onClose={() => setEditAssign(null)}
          onSaved={() => { setEditAssign(null); onRefresh() }}
          onError={onError}
          clients={[]}
          contractors={contractors}
          fixedClientId={editAssign.client_id}
          initial={editAssign}
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

      <AlertDialog open={!!deleteAssignTarget} onOpenChange={(open) => { if (!open) setDeleteAssignTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>アサインを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteAssignTarget?.label}」のアサインを削除します。月次記録が存在する場合は削除できず、非アクティブ化を案内します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteAssignTarget) deleteAssignment(deleteAssignTarget.id, deleteAssignTarget.label)
                setDeleteAssignTarget(null)
              }}
            >
              削除する
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
  const [unitPrice, setUnitPrice] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '')
      setEmail(initial?.email ?? '')
      setContractorType(initial?.contractor_type ?? 'daiko')
      setUnitPrice(initial?.unit_price ? initial.unit_price.toString() : '')
    }
  }, [open, initial])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    // 単価は動画編集者のときだけ送る。代行者編集時に送らないことで、
    // 種別を一時的に切り替えても保存済みの単価が 0 で消えないようにする。
    const payload = {
      name,
      email: email || null,
      contractor_type: contractorType,
      ...(contractorType === 'video_editor' ? { unit_price: unitPrice ? Number(unitPrice) : 0 } : {}),
    }
    try {
      const res = initial
        ? await fetch(`/api/master/contractors/${initial.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/master/contractors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
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
        {contractorType === 'video_editor' && (
          <div>
            <label className="text-sm font-medium block mb-1">単価（1本あたり）</label>
            <input type="number" inputMode="numeric" min="0" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" placeholder="0" />
            <p className="mt-1 text-xs text-gray-400">クライアントの月本数と掛け合わせて、フル納品時の支払額を自動計算します。</p>
          </div>
        )}
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
// 内訳ドラフトの空行を作る。
function emptyItemDraft(): ItemDraft {
  return { label: '', billing_amount: '', contract_start: '', contract_months: '', active: true }
}

// APIへ送る内訳ペイロードを組み立てる。
// 契約開始は type="month"（YYYY-MM）で受け取り、date列に入れられるよう「月初(YYYY-MM-01)」へ正規化する。
function itemPayload(d: ItemDraft) {
  return {
    label: d.label.trim(),
    billing_amount: d.billing_amount ? Number(d.billing_amount) : 0,
    contract_start: d.contract_start ? `${d.contract_start}-01` : null,
    contract_months: d.contract_months ? Number(d.contract_months) : null,
    active: d.active,
  }
}

function ClientFormDialog({ open, onClose, onSaved, onError, initial }: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  onError: (msg: string) => void
  initial: ClientWithItems | null
}) {
  const [name, setName] = useState('')
  const [monthlyVideoCount, setMonthlyVideoCount] = useState('')
  const [items, setItems] = useState<ItemDraft[]>([emptyItemDraft()])
  const [removedIds, setRemovedIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '')
      setMonthlyVideoCount(initial?.monthly_video_count ? initial.monthly_video_count.toString() : '')
      setRemovedIds([])
      const existing = initial?.billing_items ?? []
      if (existing.length > 0) {
        setItems(existing.map((it) => ({
          id: it.id,
          label: it.label,
          billing_amount: it.billing_amount ? it.billing_amount.toString() : '',
          contract_start: it.contract_start ? it.contract_start.slice(0, 7) : '',
          contract_months: it.contract_months ? it.contract_months.toString() : '',
          active: it.active,
        })))
      } else {
        // 新規、または内訳が未登録のクライアントは空行を1つ用意する。
        setItems([emptyItemDraft()])
      }
    }
  }, [open, initial])

  function updateItem(index: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  }

  function addItem() {
    setItems((prev) => [...prev, emptyItemDraft()])
  }

  function removeItem(index: number) {
    setItems((prev) => {
      const target = prev[index]
      if (target?.id) setRemovedIds((ids) => [...ids, target.id!])
      const next = prev.filter((_, i) => i !== index)
      return next.length > 0 ? next : [emptyItemDraft()]
    })
  }

  const multi = items.length > 1

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    // 内訳が2つ以上あるのに名前が空の行があると区別できないため、名前を必須にする。
    if (multi && items.some((it) => !it.label.trim())) {
      onError('内訳が複数あるときは、それぞれに内訳名を入力してください。')
      return
    }
    setSaving(true)
    try {
      // 1) クライアント本体（名前・月本数）を作成/更新して client_id を確定させる。
      const countNum = monthlyVideoCount ? Number(monthlyVideoCount) : 0
      let clientId = initial?.id
      if (initial) {
        // 変更のあった項目だけ送る（未送信の項目はサーバ側で触らない仕様）。
        const patch: Record<string, unknown> = {}
        if (name !== initial.name) patch.name = name
        if (countNum !== initial.monthly_video_count) patch.monthly_video_count = countNum
        if (Object.keys(patch).length > 0) {
          const res = await fetch(`/api/master/clients/${initial.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (!res.ok) throw new Error(await readErrorMessage(res, 'クライアントの保存に失敗しました。'))
        }
      } else {
        const res = await fetch('/api/master/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, monthly_video_count: countNum }),
        })
        if (!res.ok) throw new Error(await readErrorMessage(res, 'クライアントの保存に失敗しました。'))
        clientId = (await res.json()).id
      }

      // 2) 削除された内訳を消す（月次記録があるとサーバ側で弾かれる＝過去データを守る）。
      for (const id of removedIds) {
        const res = await fetch(`/api/master/billing-items/${id}`, { method: 'DELETE' })
        if (!res.ok && res.status !== 404) {
          throw new Error(await readErrorMessage(res, '内訳の削除に失敗しました（過去の請求記録がある内訳は削除できません。停止に切り替えてください）。'))
        }
      }

      // 3) 内訳を作成/更新する。表示順は並び順(index)で保存する。
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const body = { ...itemPayload(it), sort_order: i }
        if (it.id) {
          const res = await fetch(`/api/master/billing-items/${it.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!res.ok) throw new Error(await readErrorMessage(res, '内訳の保存に失敗しました。'))
        } else {
          const res = await fetch('/api/master/billing-items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, client_id: clientId }),
          })
          if (!res.ok) throw new Error(await readErrorMessage(res, '内訳の保存に失敗しました。'))
        }
      }

      setSaving(false)
      onSaved()
    } catch (err) {
      setSaving(false)
      onError(err instanceof Error ? err.message : '通信に失敗しました。接続を確認して再度お試しください。')
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
          <label className="text-sm font-medium block mb-1">月本数（動画）</label>
          <input type="number" inputMode="numeric" min="0" value={monthlyVideoCount} onChange={(e) => setMonthlyVideoCount(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" placeholder="0" />
          <p className="mt-1 text-xs text-gray-400">編集者の単価と掛け合わせて、フル納品時の支払額を自動計算します。</p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium">請求内訳</label>
            <button type="button" onClick={addItem} className="flex items-center gap-1 text-xs text-info hover:underline">
              <Plus size={12} /> 内訳を追加
            </button>
          </div>
          <p className="mb-2 text-xs text-gray-400">
            内訳ごとに金額と契約期間を設定できます（例: YouTube運用費 / Instagram運用費）。1つだけなら内訳名は空でも構いません。
          </p>

          <div className="space-y-3">
            {items.map((it, index) => (
              <div key={it.id ?? `new-${index}`} className="rounded-lg border p-3 space-y-2 bg-gray-50/50">
                <div className="flex items-center gap-2">
                  <input
                    value={it.label}
                    onChange={(e) => updateItem(index, { label: e.target.value })}
                    placeholder={multi ? '内訳名（例: YouTube運用費）' : '内訳名（任意）'}
                    className="flex-1 min-w-0 border rounded px-3 py-2 text-sm"
                  />
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeItem(index)}
                      aria-label="この内訳を削除"
                      className="shrink-0 text-gray-300 hover:text-destructive"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">請求額</label>
                    <input type="number" inputMode="numeric" value={it.billing_amount} onChange={(e) => updateItem(index, { billing_amount: e.target.value })} className="w-full border rounded px-2 py-1.5 text-sm" placeholder="0" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">契約開始月</label>
                    <input type="month" value={it.contract_start} onChange={(e) => updateItem(index, { contract_start: e.target.value })} className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">契約期間（月）</label>
                    <input type="number" inputMode="numeric" value={it.contract_months} onChange={(e) => updateItem(index, { contract_months: e.target.value })} className="w-full border rounded px-2 py-1.5 text-sm" placeholder="なし" min="1" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  <input type="checkbox" checked={it.active} onChange={(e) => updateItem(index, { active: e.target.checked })} />
                  この内訳を有効にする（外すと今後の請求チェックに出さない）
                </label>
              </div>
            ))}
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
// 種別ごとの役割名の既定値。フォームには自動入力されるが、自由に書き換え可能（例: 紹介者）。
const DEFAULT_ROLE_NAMES: Record<'daiko' | 'video_editor', string> = {
  daiko: '代行者',
  video_editor: '編集者',
}
// 「自動入力のまま（ユーザーが手で変えていない）」とみなす値。種別を切り替えたときだけ
// これらの値は新しい既定値に置き換え、手入力されたカスタム役割名は保持する。
const AUTO_ROLE_VALUES = ['', '代行者', '編集者', '動画編集']

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
  const [paymentStartMonth, setPaymentStartMonth] = useState('')
  const [paymentCount, setPaymentCount] = useState('')
  const [spreadsheetUrl, setSpreadsheetUrl] = useState('')
  const [selectedType, setSelectedType] = useState<'daiko' | 'video_editor'>('daiko')
  const [saving, setSaving] = useState(false)

  // 委託者が固定されていない（＝クライアント側からのアサイン）ときは、委託者側と同じく
  // 「種別」を先に選ぶ形にし、その種別で入力欄の自動表示と委託者ドロップダウンの絞り込みを行う。
  const showTypeSelector = !fixedContractorId && !fixedContractorType

  const selectedContractorType = fixedContractorType
    ?? (showTypeSelector
      ? selectedType
      : (contractors.find((c) => c.id === contractorId)?.contractor_type ?? 'daiko'))

  const isVideoEditor = selectedContractorType === 'video_editor'

  const dialogTitle = initial
    ? 'アサインを編集'
    : `アサインを追加（${isVideoEditor ? '動画編集者' : '代行者'}）`

  useEffect(() => {
    if (open) {
      setContractorId(fixedContractorId ?? initial?.contractor_id ?? '')
      setClientId(fixedClientId ?? initial?.client_id ?? '')
      setPayoutAmount(initial?.contractor_payout_amount?.toString() ?? '')
      setPaymentStartMonth(initial?.payment_start_month?.slice(0, 7) ?? (initial ? '' : new Date().toISOString().slice(0, 7)))
      setPaymentCount(initial?.payment_count?.toString() ?? '')
      setSpreadsheetUrl(initial?.spreadsheet_url ?? '')
      // 編集時は既存の委託者の種別に合わせる。新規は既定で代行者。
      const initType = initial
        ? contractors.find((c) => c.id === initial.contractor_id)?.contractor_type ?? 'daiko'
        : 'daiko'
      setSelectedType(initType)
      // 役割名: 編集時は既存値を、新規は種別の既定値（代行者/編集者）を自動入力する。
      const effectiveType = fixedContractorType ?? initType
      setRoleName(initial?.role_name ?? DEFAULT_ROLE_NAMES[effectiveType])
    }
  }, [open, initial, fixedContractorId, fixedContractorType, fixedClientId, contractors])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const payload: Record<string, unknown> = {
      // 役割名は種別からの自動入力値 or ユーザーの手入力値をそのまま保存する。
      role_name: roleName.trim(),
      contractor_payout_amount: isVideoEditor ? 0 : (payoutAmount ? Number(payoutAmount) : 0),
      payment_start_month: paymentStartMonth || null,
      payment_count: paymentCount ? Number(paymentCount) : null,
      spreadsheet_url: isVideoEditor ? (spreadsheetUrl || null) : null,
    }
    // 委託者・クライアントは新規作成時は必須。編集時は「変更したときだけ」送る。
    // 未変更なのに送ると、月次記録があるアサインでサーバ側の変更禁止ガード（409）に掛かるため。
    if (!initial || contractorId !== initial.contractor_id) payload.contractor_id = contractorId
    if (!initial || clientId !== initial.client_id) payload.client_id = clientId
    try {
      // 既存アサインの編集はPATCH、新規はPOST。
      const res = await fetch(
        initial ? `/api/master/assignments/${initial.id}` : '/api/master/assignments',
        {
          method: initial ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      )
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

  // 種別セレクタありのとき（クライアント側）は、選んだ種別の委託者だけをドロップダウンに出す。
  const availableContractors = showTypeSelector
    ? contractors.filter((c) => c.contractor_type === selectedType)
    : contractors

  return (
    <Dialog open={open} onClose={onClose} title={dialogTitle}>
      <form onSubmit={submit} className="space-y-4">
        {showTypeSelector && (
          <div>
            <label className="text-sm font-medium block mb-1">種別 <span className="text-destructive">*</span></label>
            <select
              value={selectedType}
              onChange={(e) => {
                const t = e.target.value as 'daiko' | 'video_editor'
                setSelectedType(t)
                setContractorId('')
                // 役割名が自動入力のままなら新しい種別の既定値へ置き換える（手入力済みなら保持）。
                setRoleName((prev) => (AUTO_ROLE_VALUES.includes(prev.trim()) ? DEFAULT_ROLE_NAMES[t] : prev))
              }}
              className="w-full border rounded px-3 py-2 text-sm"
            >
              <option value="daiko">代行者</option>
              <option value="video_editor">動画編集者</option>
            </select>
          </div>
        )}

        {!fixedContractorId && (
          <div>
            <label className="text-sm font-medium block mb-1">委託者 <span className="text-destructive">*</span></label>
            <select required value={contractorId} onChange={(e) => setContractorId(e.target.value)} className="w-full border rounded px-3 py-2 text-sm">
              <option value="">選択してください</option>
              {availableContractors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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

        <div>
          <label className="text-sm font-medium block mb-1">役割名 <span className="text-destructive">*</span></label>
          <input value={roleName} onChange={(e) => setRoleName(e.target.value)} required className="w-full border rounded px-3 py-2 text-sm" placeholder="例: 紹介者" />
          <p className="mt-1 text-xs text-gray-400">種別に応じて自動入力されます。必要に応じて自由に変更できます（例: 紹介者）。</p>
        </div>

        <div className={`transition-opacity duration-150 ${isVideoEditor ? 'opacity-0 h-0 overflow-hidden' : 'opacity-100'}`}>
          <label className="text-sm font-medium block mb-1">報酬額</label>
          <input type="number" inputMode="numeric" value={payoutAmount} onChange={(e) => setPayoutAmount(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" placeholder="0" />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium block mb-1">支払い開始月</label>
            <input type="month" value={paymentStartMonth} onChange={(e) => setPaymentStartMonth(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" />
            <p className="mt-1 text-xs text-gray-400">未入力なら開始月を限定しません。</p>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">支払い回数</label>
            <input type="number" inputMode="numeric" min="1" value={paymentCount} onChange={(e) => setPaymentCount(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" placeholder="継続" />
            <p className="mt-1 text-xs text-gray-400">未入力なら継続扱いです。</p>
          </div>
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
