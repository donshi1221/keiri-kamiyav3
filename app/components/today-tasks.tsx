'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { TaskItem, TaskGroup } from '@/lib/ui-types'

interface Props {
  overdueItems: TaskItem[]
  inWindowItems: TaskItem[]
  // 1チップが複数レコードを表すことがあるため、飛び先は配列で渡す
  // （先頭へスクロールし、まとめた全行をハイライトする）。
  onJump?: (targets: string[]) => void
}

// グループの表示順と見出し名。unit は「何が何件あるか」を見出しに出すための単位で、
// 委託者は人、クライアントは会社を数える。
const GROUP_DEFS: { key: TaskGroup; title: string; unit: string }[] = [
  { key: 'contractorInvoice', title: '請求書受領', unit: '名' },
  { key: 'contractorReserve', title: '支払い予約', unit: '名' },
  { key: 'contractorPaid', title: '支払い確認', unit: '名' },
  { key: 'clientInvoice', title: 'クライアント請求書送付', unit: '社' },
  { key: 'clientPayment', title: 'クライアント入金確認', unit: '社' },
]

// 同じ名前のチップ1つ分。targets は飛び先（重複は除く）、count は表示する件数。
interface Chip {
  label: string
  targets: string[]
  count: number
}

// 同一人物・同一クライアントの項目を1チップにまとめる。
// 件数は「飛び先の数」で数えるため、複数アサインでもチェックが1つに集約されている作業
// （委託者の支払い確認）は 1 件として扱われ、実際に必要な操作の数とチップの件数が一致する。
function buildChips(items: TaskItem[]): Chip[] {
  const order: string[] = []
  const byLabel = new Map<string, { targets: string[]; plain: number }>()
  for (const item of items) {
    let entry = byLabel.get(item.label)
    if (!entry) {
      entry = { targets: [], plain: 0 }
      byLabel.set(item.label, entry)
      order.push(item.label)
    }
    // 飛び先が無い項目はまとめようがないので、件数だけ数える。
    if (!item.target) entry.plain += 1
    else if (!entry.targets.includes(item.target)) entry.targets.push(item.target)
  }
  return order.map((label) => {
    const entry = byLabel.get(label)!
    return { label, targets: entry.targets, count: entry.targets.length + entry.plain }
  })
}

// 名前チップの横並び。縦に1件1行で並べると人数×アサイン数だけ行が伸びるため、
// 折り返しつきの横並びにして高さを抑える。スマホでも押せるよう最低44pxの高さを確保する。
function ChipList({ chips, onJump }: {
  chips: Chip[]
  onJump?: (targets: string[]) => void
}) {
  const base = 'inline-flex min-h-11 items-center rounded border border-gray-200 bg-white px-2 py-1 text-xs md:min-h-8'
  return (
    <ul className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <li key={chip.label}>
          {chip.targets.length > 0 && onJump ? (
            <button type="button" onClick={() => onJump(chip.targets)} className={`${base} hover:bg-gray-50`}>
              {chip.label}
              {chip.count > 1 && <span className="ml-1 text-gray-500">（{chip.count}）</span>}
            </button>
          ) : (
            <span className={base}>
              {chip.label}
              {chip.count > 1 && <span className="ml-1 text-gray-500">（{chip.count}）</span>}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

// 同じ作業の項目を「作業名 ◯名（◯件）」の1行に集約し、クリックで開閉する。
// 件数は折りたたんでいても見えるので、閉じていても対応漏れには気づける。
function CollapsibleGroup({ title, unit, chips, tone, onJump }: {
  title: string
  unit: string
  chips: Chip[]
  tone: 'danger' | 'warning'
  onJump?: (targets: string[]) => void
}) {
  // チップ表示なら開いていても数行で収まるため、初期状態は開いておく（何をやるかが一目で分かる）。
  const [open, setOpen] = useState(true)
  const toneClass = tone === 'danger' ? 'text-danger bg-danger-subtle' : 'text-warning bg-warning-subtle'
  const total = chips.reduce((sum, c) => sum + c.count, 0)
  // まとめた結果、名前の数と件数が食い違うときだけ両方出す（同じなら件数だけで十分）。
  const countLabel = chips.length === total ? `${total}件` : `${chips.length}${unit}（${total}件）`
  return (
    <li className={`rounded text-sm ${toneClass}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-2 py-1 text-left"
      >
        <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="flex-1">{title} {countLabel}</span>
      </button>
      {open && (
        <div className="pb-1.5 pl-7 pr-2">
          <ChipList chips={chips} onJump={onJump} />
        </div>
      )}
    </li>
  )
}

function TaskSection({ heading, items, tone, onJump }: {
  heading: string
  items: TaskItem[]
  tone: 'danger' | 'warning'
  onJump?: (targets: string[]) => void
}) {
  const rest = items.filter((i) => !i.group)
  const groups = GROUP_DEFS
    .map((def) => ({ ...def, chips: buildChips(items.filter((i) => i.group === def.key)) }))
    .filter((g) => g.chips.length > 0)
  const headingClass = tone === 'danger' ? 'text-danger' : 'text-warning'
  const itemClass = tone === 'danger' ? 'text-danger bg-danger-subtle' : 'text-warning bg-warning-subtle'
  // 見出しの件数はチップと同じ数え方に揃える（まとめた分だけ items.length より少なくなる）。
  const total = rest.length + groups.reduce((sum, g) => sum + g.chips.reduce((s, c) => s + c.count, 0), 0)
  return (
    <div>
      <p className={`text-xs font-medium mb-1.5 ${headingClass}`}>{heading} {total}件</p>
      <ul className="space-y-1">
        {/* 単発・全社タスクはまとめる相手がいないため、従来どおり1件1行で出す。 */}
        {rest.map((item, i) => {
          const target = item.target
          return (
          <li key={i} className={`text-sm rounded ${itemClass}`}>
            {target && onJump ? (
              <button
                type="button"
                onClick={() => onJump([target])}
                // スマホでのタップ領域を44px確保する（PCは従来の行高のまま）。
                className="flex min-h-11 w-full items-center px-2 py-1 text-left md:min-h-0"
              >
                {item.label}
              </button>
            ) : (
              <span className="block px-2 py-1">{item.label}</span>
            )}
          </li>
          )
        })}
        {groups.map((g) => (
          <CollapsibleGroup key={g.key} title={g.title} unit={g.unit} chips={g.chips} tone={tone} onJump={onJump} />
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
