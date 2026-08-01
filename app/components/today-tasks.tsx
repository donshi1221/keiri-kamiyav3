'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { TaskItem, TaskGroup } from '@/lib/ui-types'

interface Props {
  overdueItems: TaskItem[]
  inWindowItems: TaskItem[]
  onJump?: (target: string) => void
}

const GROUP_LABELS: Record<TaskGroup, string> = {
  clientInvoice: 'クライアント請求書送付',
  clientPayment: 'クライアント入金確認',
}

// 飛び先がある項目だけボタンにして、該当行までスクロールできるようにする。
// 飛び先が無い項目は押しても行き先がないため、従来どおりのテキスト表示に留める。
function TaskLabel({ item, onJump, className }: {
  item: TaskItem
  onJump?: (target: string) => void
  className?: string
}) {
  const target = item.target
  if (!target || !onJump) return <span className={`block ${className ?? ''}`}>{item.label}</span>
  return (
    <button
      type="button"
      onClick={() => onJump(target)}
      // スマホでのタップ領域を44px確保する（PCは従来の行高のまま）。
      className={`flex min-h-11 w-full items-center text-left md:min-h-0 ${className ?? ''}`}
    >
      {item.label}
    </button>
  )
}

// クライアント系の項目はクライアント数の分だけ並んで一覧が長くなるため、
// 「グループ名 ◯件」の1行に集約し、クリックで開閉する（初期状態は閉じる）。
// 件数は常に見えるので、折りたたんでいても対応漏れには気づける。
function CollapsibleGroup({ title, items, tone, onJump }: {
  title: string
  items: TaskItem[]
  tone: 'danger' | 'warning'
  onJump?: (target: string) => void
}) {
  const [open, setOpen] = useState(false)
  const toneClass = tone === 'danger' ? 'text-danger bg-danger-subtle' : 'text-warning bg-warning-subtle'
  return (
    <li className={`rounded text-sm ${toneClass}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-2 py-1 text-left"
      >
        <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="flex-1">{title} {items.length}件</span>
      </button>
      {open && (
        <ul className="space-y-0.5 pb-1.5 pl-7 pr-2">
          {items.map((item, i) => (
            <li key={i}>
              <TaskLabel item={item} onJump={onJump} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function TaskSection({ heading, items, tone, onJump }: {
  heading: string
  items: TaskItem[]
  tone: 'danger' | 'warning'
  onJump?: (target: string) => void
}) {
  const rest = items.filter((i) => !i.group)
  const groups = (Object.keys(GROUP_LABELS) as TaskGroup[])
    .map((g) => ({ group: g, items: items.filter((i) => i.group === g) }))
    .filter((x) => x.items.length > 0)
  const headingClass = tone === 'danger' ? 'text-danger' : 'text-warning'
  const itemClass = tone === 'danger' ? 'text-danger bg-danger-subtle' : 'text-warning bg-warning-subtle'
  return (
    <div>
      <p className={`text-xs font-medium mb-1.5 ${headingClass}`}>{heading} {items.length}件</p>
      <ul className="space-y-1">
        {rest.map((item, i) => (
          <li key={i} className={`text-sm rounded ${itemClass}`}>
            <TaskLabel item={item} onJump={onJump} className="px-2 py-1" />
          </li>
        ))}
        {groups.map(({ group, items: groupItems }) => (
          <CollapsibleGroup key={group} title={GROUP_LABELS[group]} items={groupItems} tone={tone} onJump={onJump} />
        ))}
      </ul>
    </div>
  )
}

export default function TodayTasks({ overdueItems, inWindowItems, onJump }: Props) {
  if (overdueItems.length === 0 && inWindowItems.length === 0) {
    return (
      <section className="rounded-lg border bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-1">今日やること</h2>
        <p className="text-sm text-gray-600">未対応のタスクはありません。</p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border bg-white p-4 space-y-3">
      <h2 className="text-sm font-semibold text-gray-900">今日やること</h2>
      {overdueItems.length > 0 && (
        <TaskSection heading="期限超過" items={overdueItems} tone="danger" onJump={onJump} />
      )}
      {inWindowItems.length > 0 && (
        <TaskSection heading="対応期間中" items={inWindowItems} tone="warning" onJump={onJump} />
      )}
    </section>
  )
}
