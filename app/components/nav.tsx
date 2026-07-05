'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { LayoutDashboard, History, Users, BookText } from 'lucide-react'

const links = [
  { href: '/', label: 'ダッシュボード', icon: LayoutDashboard },
  { href: '/history', label: '履歴', icon: History },
  { href: '/master', label: 'マスタ管理', icon: Users },
  { href: '/tax', label: '税務メモ', icon: BookText },
]

export default function Nav() {
  const pathname = usePathname()

  return (
    <>
      {/* PC・タブレット表示（md以上）: 上部の横並びナビ */}
      <nav className="hidden border-b bg-white sticky top-0 z-10 md:block">
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

      {/* スマホ表示（md未満）: 画面上部にタイトルのみ */}
      <header className="border-b bg-white sticky top-0 z-10 md:hidden">
        <div className="px-4 flex items-center h-12">
          <span className="font-bold text-sm text-gray-800">keiri-v3</span>
        </div>
      </header>

      {/* スマホ表示（md未満）: 画面下部固定のタブバー */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="メインナビゲーション"
      >
        <div className="flex">
          {links.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px]',
                  active ? 'text-gray-900' : 'text-gray-400'
                )}
              >
                <Icon size={20} />
                {label}
              </Link>
            )
          })}
        </div>
      </nav>
    </>
  )
}
