'use client'

import { X } from 'lucide-react'

export default function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div
      role="alert"
      className="fixed inset-x-4 bottom-20 z-[60] flex items-center justify-between gap-3 rounded-lg border border-danger-subtle bg-danger-subtle px-4 py-3 text-sm text-danger shadow-lg md:inset-x-auto md:right-4 md:bottom-4 md:max-w-md"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 text-danger hover:text-danger"
        aria-label="閉じる"
      >
        <X size={14} />
      </button>
    </div>
  )
}
