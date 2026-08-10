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

// ─── 注意行の確認済みキー ─────────────────────────────────────
// 「[注意] 四季様 台本作成費 7/28 — 記載日（7/28）の作業実施をご確認ください」のような注意は、
// 人が確認したら消し込みたい。ところが判定理由（check_notes）は再チェックのたびに丸ごと
// 作り直されるため、行そのものには「確認済み」を残せない。そこで注意1件を指す安定したキーを作り、
// invoice_uploads.confirmed_cautions（キーの配列）に貯める方式にしている。
//
// キーの材料は明細ラベルの原文と、そこに書かれた「N/M」。ラベルだけでも実質一意だが、
// N/M を明示的に付けることで「どの回数・どの日付についての確認だったか」がキーを見ただけで分かる。
// 空白（半角・全角）は請求書ごとの体裁差でしかないため除去して比べる。
//
// サーバー（lib/invoice-check）は注意行を作るときにこのキーを求め、画面（app/invoice-check）は
// 表示中の注意行の本文からラベル部分を取り出して同じ関数でキーを作る。両者が同じ実装を使えるよう
// server-only ではないこのファイルに置く。
export function cautionKeyOf(label: string): string {
  const base = label.replace(/[\s　]/g, '')
  const nm = /(\d+)\s*\/\s*(\d+)/.exec(label)
  return `${base}|${nm ? `${nm[1]}/${nm[2]}` : ''}`
}

// 注意行の本文は必ず「<明細ラベル原文> — <説明>」の形で作る（lib/invoice-check）。
// 画面はこの区切りでラベルを取り出し、cautionKeyOf に渡して確認済みキーを復元する。
// キーを本文に埋め込む方式（「…|key=…」）だと、埋め込みがそのまま人の目に触れてしまうため採らない。
export const CAUTION_LABEL_SEPARATOR = ' — '

// 注意行（および確認済みのOK行）の本文からキーを復元する。区切りが無い行＝この仕組みの対象外
// （過去に保存された注意行など）は null を返し、画面側でボタンを出さない。
export function cautionKeyFromNoteText(text: string): string | null {
  // 後ろから探すのは、明細ラベル自体に「 — 」が含まれていても全体をラベルとして拾うため
  // （注意の説明文の側には「 — 」を入れない約束にしてある）。
  const index = text.lastIndexOf(CAUTION_LABEL_SEPARATOR)
  if (index <= 0) return null
  return cautionKeyOf(text.slice(0, index))
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
