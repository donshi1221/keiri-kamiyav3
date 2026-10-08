// 請求書の「追加費用」（通常の作業分でも実費の立て替えでもない追加の請求）の扱い。
// 支払予定に相手がいないため自動では判定できず、人が「認める／認めない」を決める。
// ここには、明細を指すキーの作り方と、決定を踏まえた金額の比べ方だけを置く（DBには触らない）。
// サーバー（照合・操作のAPI）と画面の両方から使えるよう server-only にしない。
import type { InvoiceExtraItem, InvoiceExtractedItem } from './ui-types'

// 追加費用の明細1件を指すキー。「認めた」記録（expenses.invoice_item_key）と「認めない」記録
// （invoice_uploads.rejected_extras）の両方がこのキーで明細を指す。
// 材料は名称（空白は体裁差なので除く。注意行のキーと同じ考え方）と金額、それに同じ名称・金額の
// 明細の中で何番目か。同じ修正費が2行並んだ請求書で、1行目だけ認めて2行目は認めない、を取り違えないため。
// 行の位置（明細全体の何行目か）を使わないのは、再読み取りで他の行が増減しただけでキーが変わってしまうため。
function extraItemKey(label: string, amount: number | null, occurrence: number): string {
  return `${label.replace(/[\s　]/g, '')}|${amount ?? ''}|${occurrence}`
}

// 明細から追加費用の行だけを取り出し、キーを付ける。kind を持たない過去の読み取り結果には
// 追加費用の行が無い（work とみなされる）ので、空配列になるだけで従来どおり動く。
export function keyedExtraItems(items: InvoiceExtractedItem[]): Omit<InvoiceExtraItem, 'decision'>[] {
  const seen = new Map<string, number>()
  return items
    .filter((item) => item.kind === 'extra')
    .map((item) => {
      const base = extraItemKey(item.label, item.amount, 0)
      const occurrence = (seen.get(base) ?? 0) + 1
      seen.set(base, occurrence)
      return {
        key: extraItemKey(item.label, item.amount, occurrence),
        label: item.label,
        amount: item.amount,
        client: item.client ?? null,
      }
    })
}

// 追加費用の各行に今の扱いを付ける。両方に記録がある行は「認めた」を優先する
// （認めた分は支払予定額に既に足されているため、認めない扱いにすると金額の比べ方と食い違う）。
export function decideExtraItems(
  items: InvoiceExtractedItem[],
  approvedKeys: ReadonlySet<string>,
  rejectedKeys: ReadonlySet<string>
): InvoiceExtraItem[] {
  return keyedExtraItems(items).map((item) => ({
    ...item,
    decision: approvedKeys.has(item.key) ? 'approved' : rejectedKeys.has(item.key) ? 'rejected' : 'pending',
  }))
}

// 請求額と支払予定額を、追加費用の扱いを踏まえて比べる。
// 認めた追加費用は支払予定額（expected）に既に足されているので、そのまま比べればよい。
// 未決定・認めなかった追加費用は支払予定に入っていないため、請求額から除いて比べる。こうしないと
// 「追加費用の分だけ多い」ことが合計の不一致としても指摘され、同じことを二重に伝えてしまう。
// 除いても合わなければ、追加費用とは別の食い違いがあるということなので不一致になる。
// 金額が読めていない追加費用は引きようがないので 0 として扱う（その行は別に保留になる）。
export function compareTotalWithExtras(
  billed: number,
  expected: number,
  extras: InvoiceExtraItem[]
): { matches: boolean; billedWithoutExtras: number; excluded: number } {
  const excluded = extras
    .filter((item) => item.decision !== 'approved')
    .reduce((sum, item) => sum + (item.amount ?? 0), 0)
  const billedWithoutExtras = billed - excluded
  return { matches: billedWithoutExtras === expected, billedWithoutExtras, excluded }
}
