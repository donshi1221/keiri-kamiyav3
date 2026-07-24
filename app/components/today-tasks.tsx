'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { TaskItem, TaskGroup } from '@/lib/ui-types'

interface Props {
  overdueItems: TaskItem[]
  inWindowItems: TaskItem[]
}

const GROUP_LABELS: Record<TaskGroup, string> = {
  clientInvoice: 'クライアント請求書送付',
  clientPayment: 'クライアント入金確認',
}

// クライアント系の項目はクライアント数の分だけ並んで一覧が長くなるため、
// 「グループ名 ◯件」の1行に集約し、クリックで開閉する（初期状態は閉じる）。
// 件数は常に見えるので、折りたたんでいても対応漏れには気づける。
function CollapsibleGroup({ title, items, tone }: {
  title: string
  items: TaskItem[]
  tone: 'danger' | 'warning'
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
            <li key={i}>{item.label}</li>
          ))}
        </ul>
      )}
    </li>
  )
}

function TaskSection({ heading, items, tone }: {
  heading: string
  items: TaskItem[]
  tone: 'danger' | 'warning'
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
          <li key={i} className={`text-sm rounded px-2 py-1 ${itemClass}`}>
            {item.label}
          </li>
        ))}
        {groups.map(({ group, items: groupItems }) => (
          <CollapsibleGroup key={group} title={GROUP_LABELS[group]} items={groupItems} tone={tone} />
        ))}
      </ul>
    </div>
  )
}

export default function TodayTasks({ overdueItems, inWindowItems }: Props) {
  if (overdueItems.length === 0 && inWindowItems.length === 0) {
    return (
      <section className="rounded-lg border bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">今日やること</h2>
        <p className="text-sm text-gray-600">未対応のタスクはありません。</p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border bg-white p-4 space-y-3">
      <h2 className="text-sm font-semibold text-gray-700">今日やること</h2>
      {overdueItems.length > 0 && (
        <TaskSection heading="期限超過" items={overdueItems} tone="danger" />
      )}
      {inWindowItems.length > 0 && (
        <TaskSection heading="対応期間中" items={inWindowItems} tone="warning" />
      )}
    </section>
  )
}
