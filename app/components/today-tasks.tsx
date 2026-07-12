interface TaskItem {
  label: string
}

interface Props {
  overdueItems: TaskItem[]
  inWindowItems: TaskItem[]
}

export default function TodayTasks({ overdueItems, inWindowItems }: Props) {
  if (overdueItems.length === 0 && inWindowItems.length === 0) {
    return (
      <section className="rounded-lg border bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">今日やること</h2>
        <p className="text-sm text-gray-400">未対応のタスクはありません。</p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border bg-white p-4 space-y-3">
      <h2 className="text-sm font-semibold text-gray-700">今日やること</h2>
      {overdueItems.length > 0 && (
        <div>
          <p className="text-xs font-medium text-danger mb-1.5">期限超過 {overdueItems.length}件</p>
          <ul className="space-y-1">
            {overdueItems.map((item, i) => (
              <li key={i} className="text-sm text-danger bg-danger-subtle rounded px-2 py-1">
                {item.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      {inWindowItems.length > 0 && (
        <div>
          <p className="text-xs font-medium text-warning mb-1.5">対応期間中 {inWindowItems.length}件</p>
          <ul className="space-y-1">
            {inWindowItems.map((item, i) => (
              <li key={i} className="text-sm text-warning bg-warning-subtle rounded px-2 py-1">
                {item.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
