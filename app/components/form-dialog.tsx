'use client'

import { useEffect } from 'react'

// app/master/page.tsx と app/tax/page.tsx にほぼ同一のまま重複定義されていた
// モーダルDialogを共通化したもの。max-w だけページごとに異なっていたため prop 化している。
export function FormDialog({ open, onClose, title, maxWidth = 'max-w-md', children }: {
  open: boolean
  onClose: () => void
  title: string
  maxWidth?: string
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
      <div className={`bg-white rounded-xl shadow-xl w-full ${maxWidth} mx-4 p-6 max-h-[85dvh] overflow-y-auto`}>
        <h2 className="text-base font-semibold mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}
