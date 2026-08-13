'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { nowJST } from '@/lib/dates'
import { LayoutDashboard, CalendarClock, ReceiptText, Wallet, Users, BookText, LogOut, Download } from 'lucide-react'

// 「先月」の遷移先は表示時点の年月に依存するため、リンク一覧は描画のたびに組み立てる。
// 基準時刻を JST 固定の nowJST にしているのは、サーバー描画（UTC）とクライアント描画で
// 月がズレて hydration 不一致になるのを防ぐため。
// shortLabel: スマホ下部タブ用の短い表記（6タブの幅に収めるため）
function buildLinks(): { href: string; label: string; shortLabel?: string; icon: typeof LayoutDashboard }[] {
  const today = nowJST()
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  return [
    { href: '/', label: 'ダッシュボード', shortLabel: 'ホーム', icon: LayoutDashboard },
    {
      href: `/?year=${lastMonth.getFullYear()}&month=${lastMonth.getMonth() + 1}`,
      label: '先月',
      icon: CalendarClock,
    },
    { href: '/invoice-check', label: '請求書チェック', shortLabel: '請求書', icon: ReceiptText },
    { href: '/expense-check', label: '経費チェック', shortLabel: '経費', icon: Wallet },
    { href: '/master', label: 'マスタ管理', shortLabel: 'マスタ', icon: Users },
    { href: '/tax', label: '税務メモ', icon: BookText },
  ]
}

export default function Nav() {
  const pathname = usePathname()
  const router = useRouter()
  const links = buildLinks()

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // 通信に失敗してもログイン画面へは遷移させる（Cookieはサーバー側でのみ消せるため再ログインで解決）。
    }
    router.replace('/login')
    router.refresh()
  }

  // 未ログイン時はどのリンクを押してもログイン画面へ戻されるだけなので、ナビ自体を出さない。
  // 請求書・経費のアップロードは社外の人や代表が開く公開画面なので、社内向けの導線を見せない。
  // 「/invoice」「/expense」だけを対象にするのは、前方一致にすると社内画面（/invoice-check・
  // /expense-check）まで巻き込んでナビが消えてしまうため。
  if (
    pathname === '/login' ||
    pathname === '/invoice' ||
    pathname.startsWith('/invoice/') ||
    pathname === '/expense' ||
    pathname.startsWith('/expense/')
  ) {
    return null
  }

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
          <a
            href="/api/backup/export"
            download
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded text-sm text-gray-500 hover:bg-gray-100"
          >
            <Download size={16} />
            バックアップ
          </a>
          <button
            type="button"
            onClick={handleLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm text-gray-500 hover:bg-gray-100"
          >
            <LogOut size={16} />
            ログアウト
          </button>
        </div>
      </nav>

      {/* スマホ表示（md未満）: 画面上部にタイトルとログアウト */}
      <header className="border-b bg-white sticky top-0 z-10 md:hidden">
        <div className="px-4 flex items-center h-12">
          <span className="font-bold text-sm text-gray-800">keiri-v3</span>
          <a
            href="/api/backup/export"
            download
            aria-label="バックアップをダウンロード"
            className="ml-auto flex h-11 w-11 items-center justify-center rounded text-gray-500 hover:bg-gray-100"
          >
            <Download size={18} />
          </a>
          <button
            type="button"
            onClick={handleLogout}
            aria-label="ログアウト"
            className="flex h-11 w-11 items-center justify-center rounded text-gray-500 hover:bg-gray-100"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {/* スマホ表示（md未満）: 画面下部固定のタブバー */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="メインナビゲーション"
      >
        <div className="flex">
          {links.map(({ href, label, shortLabel, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] whitespace-nowrap',
                  active ? 'text-gray-900' : 'text-gray-400'
                )}
              >
                <Icon size={20} />
                {shortLabel ?? label}
              </Link>
            )
          })}
        </div>
      </nav>
    </>
  )
}
