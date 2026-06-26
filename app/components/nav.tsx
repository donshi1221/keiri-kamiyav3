'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const links = [
  { href: '/', label: 'ダッシュボード' },
  { href: '/history', label: '履歴' },
  { href: '/master', label: 'マスタ管理' },
  { href: '/tax', label: '税務メモ' },
]

export default function Nav() {
  const pathname = usePathname()

  return (
    <nav className="border-b bg-white sticky top-0 z-10">
      <div className="max-w-6xl mx-auto px-4 flex items-center gap-6 h-14">
        <span className="font-bold text-sm text-gray-800">keiri-v3</span>
        <div className="flex gap-1">
          {links.map(({ href, label }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'px-3 py-1.5 rounded text-sm transition-colors',
                  active ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
                )}
              >
                {label}
              </Link>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
