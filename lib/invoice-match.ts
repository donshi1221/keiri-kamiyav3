// 請求書の明細ラベルとマスタのクライアント名を突き合わせるための共通処理。
// 照合本体（lib/invoice-check）は server-only のため画面から import できない。
// 経費のその場登録ダイアログ（app/invoice-check）でも「この明細はどのクライアント分か」を
// 同じ基準で推定する必要があるため、サーバー・画面の両方から使えるここに置く。

// 名前の比較は表記ゆれで落ちやすい。空白（半角・全角）は意味を持たないので除去してから比べる。
// 「株式会社」等の法人格は略さずそのまま扱う（略すと別法人まで一致してしまうため）。
// 請求書の明細は「〇〇様」のように敬称付きで書かれるのが普通なので、末尾の敬称も削る
// （名前の途中に「様」が含まれるケースを誤って消さないよう、末尾アンカーに限定）。
export function normalizeName(value: string): string {
  return value.replace(/[\s　]/g, '').replace(/(様|さま|御中|殿)$/, '')
}

// 請求書の明細は法人格を省いて書かれるのが普通（「株式会社四季」→「四季様 台本作成費」）。
// 正式名から法人格を外した形も呼び名の候補に加え、別名を登録しなくても拾えるようにする。
// 除くのは先頭・末尾に付く一般的な法人格だけ（名前の途中を削ると別法人と混ざるため）。
const CORPORATE_FORMS = [
  '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人', '特定非営利活動法人', '社会福祉法人',
  '株式会社', '有限会社', '合同会社', '合資会社', '合名会社', '医療法人', '学校法人', '宗教法人',
  '（株）', '(株)', '（有）', '(有)', '（同）', '(同)', '㈱', '㈲',
]

export function stripCorporateForm(normalized: string): string {
  for (const form of CORPORATE_FORMS) {
    if (normalized.startsWith(form)) return normalized.slice(form.length)
    if (normalized.endsWith(form)) return normalized.slice(0, -form.length)
  }
  return normalized
}

// 別名は1つの入力欄にカンマ区切りで登録する。全角カンマ・読点で区切る人もいるため、いずれも区切りとして扱う。
export function parseClientAliases(value: string | null | undefined): string[] {
  if (!value) return []
  return value.split(/[,、，]/).map((s) => s.trim()).filter((s) => s.length > 0)
}

// 明細ラベルの中から探す「そのクライアントの呼び名」の一覧。
// 正式名・法人格を外した形・別名（通称や字違い）を、比較しやすいよう正規化して重複を除く。
export function clientMatchNames(name: string, aliases: string | null | undefined): string[] {
  const normalized = normalizeName(name)
  const candidates = [normalized, stripCorporateForm(normalized), ...parseClientAliases(aliases).map(normalizeName)]
  return [...new Set(candidates.filter((c) => c.length > 0))]
}

// 明細ラベルの中に含まれる呼び名のうち、最も長く一致したものの文字数（0＝一致なし）。
// 「四季様 台本作成費 7/28」のように工程名や支払回数が付くため、名前どうしの一致では拾えない。
// 長さで比べるのは、「がじゅまる」と「がじゅまるレンタカー」の両方が登録されているとき、
// 短い方にも当たってしまう（＝候補が複数になる）のを避けて長い方に寄せるため。
export function matchedNameLength(label: string, names: string[]): number {
  let best = 0
  for (const name of names) {
    if (name.length > best && label.includes(name)) best = name.length
  }
  return best
}

// 明細ラベルの「N/M」を日付（月/日）として読む。
// クライアントによっては「7/28」が支払回数ではなく台本作成日を指す運用があり（clients.nm_as_date）、
// 経費明細の日付欄を埋めるときも同じ書き方から日付を拾いたいため、抽出をここに1本化する。
// 「2026/8」のような年月を日付と読み違えないよう、3桁以上を含む並びは対象外にする。
const SLASH_DATE_PATTERN = /(\d+)\s*\/\s*(\d+)/g

export function extractItemDate(label: string): { month: number; day: number } | null {
  for (const [, left, right] of label.matchAll(SLASH_DATE_PATTERN)) {
    if (left.length > 2 || right.length > 2) continue
    const month = Number(left)
    const day = Number(right)
    if (month < 1 || month > 12 || day < 1 || day > 31) continue
    return { month, day }
  }
  return null
}

// 明細から読んだ「月/日」に年を補って 'YYYY-MM-DD'（expenses.expense_date の形式）にする。
// 基準は請求書の対象月。12月分の請求書に「1/5」と書かれるように月をまたぐ書き方があるため、
// 基準月との差が半年を超える場合は年をまたいだものとして扱う。
export function toExpenseDate(
  month: number,
  day: number,
  baseYear: number,
  baseMonth: number
): string {
  const diff = month - baseMonth
  const year = diff > 6 ? baseYear - 1 : diff < -6 ? baseYear + 1 : baseYear
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
