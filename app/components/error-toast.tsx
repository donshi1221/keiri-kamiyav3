'use client'

import { X } from 'lucide-react'

export default function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 text-red-400 hover:text-red-600"
        aria-label="閉じる"
      >
        <X size={14} />
      </button>
    </div>
  )
}
