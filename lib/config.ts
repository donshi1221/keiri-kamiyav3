// アプリ全体で使う「設定値」を1か所に集約する。
// 秘密情報（APIキー等）は .env のまま扱い、ここには「振る舞いを決める値」だけを置く。
// 環境変数で上書きでき、未設定時は既定値を使う。

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// 税務AIチャットと請求書読み取りで使う Gemini のモデル名。
// 固定バージョン名は提供終了で 429/404 になった実績があるため、常に最新を指す別名を既定にする。
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest'

// 税務アドバイスのファイルアップロード上限（バイト）。既定 5MB。
export const UPLOAD_MAX_BYTES = intFromEnv('UPLOAD_MAX_BYTES', 5 * 1024 * 1024)

// 月次生成cronが何日成功していなければ「止まっている疑い」とみなすか。既定35日（1か月分の未実行を検知）。
export const CRON_STALE_ALERT_DAYS = intFromEnv('CRON_STALE_ALERT_DAYS', 35)

// 単発タスクを「今日やること（対応期間中）」に載せ始める日数。期日のこの日数前から表示する。既定3日。
export const ONE_TIME_TASK_WINDOW_DAYS = intFromEnv('ONE_TIME_TASK_WINDOW_DAYS', 3)

// 自社名。請求書の宛名が自社宛かを判定する際の「正解」として使う。
// 社名変更や検証環境での差し替えに備えて環境変数で上書きできるようにする。
export const COMPANY_NAME = process.env.COMPANY_NAME ?? 'KaMiYa株式会社'

// 「その他経費」に含めるMF勘定科目（コードまたは名前）。外注費は含めない。
export const MF_EXPENSE_ACCOUNTS = (process.env.MF_EXPENSE_ACCOUNTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ─── 請求書未提出リマインド（Chatwork）─────────────────────────────
// 送信前に画面で編集できる「たたき台」。プレースホルダは送信時にサーバーで置き換える:
//   {name}  委託者名 / {month} 請求書の対象月（＝支払月の前月） / {url} 請求書受付URL
// 文面は運用で変わるため env で上書きできるようにする（改行は \n で書く）。
export const INVOICE_REMINDER_TEMPLATE =
  process.env.INVOICE_REMINDER_TEMPLATE?.replace(/\\n/g, '\n') ??
  [
    'お世話になっております！',
    '{month}月分の請求書が確認できておりません。',
    '',
    'お手数ですが、以下のURLよりご提出をお願いいたします。',
    '{url}',
  ].join('\n')

// ─── 経費アップロード（モバイルICOCA・特急券など）─────────────────────────────
// 代表が明細1行ごとに選ぶ経費科目の選択肢。画面のプルダウンとサーバー側の検証で同じ一覧を使うため
// ここ1か所に置く（片方だけ増やすと「画面では選べるのに保存で弾かれる」食い違いが起きるため）。
// 科目は税理士との取り決めで変わりうるので as const で並びごと固定し、型もここから導く。
export const EXPENSE_CATEGORIES = [
  '旅費交通費',
  '福利厚生費',
  '会議費',
  '地代家賃（レンタルルーム）',
] as const

// 明細1行の用途。金額の行き先がそれぞれ違うため、読み取り後に代表が必ずどれかを選ぶ。
//   client_billed: クライアントに請求する（client_expenses へ登録される）
//   company:       自社経費（マネーフォワード側で計上済みなので、ここでは金額を集計しない）
//   excluded:      対象外（私用など）
// 科目と同じく、検証（zod）と画面の選択肢が食い違わないよう1か所に置く。
export const EXPENSE_ITEM_KINDS = ['client_billed', 'company', 'excluded'] as const

// 経費アップロードで受け付けるファイル種別。ICOCAの利用履歴はPDF、特急券の領収書は
// スマホで撮った画像で届くため両方を許す（Geminiはどちらもそのまま読める）。
// 画像はサブタイプが機種でまちまち（jpeg / heic / webp）なので前方一致で判定する。
export const EXPENSE_UPLOAD_MIME_PREFIXES = ['application/pdf', 'image/'] as const

// ─── 納品チェック（編集者スプレッドシート）─────────────────────────────
// 編集者の納品スプレッドシートは全員同じ列構成（A:納品〆切 / B:本数 / C:動画のNo / D:納品URL）。
// 列は0始まりのインデックスで持ち、将来レイアウトが変わっても env で追従できるようにする。
export const DELIVERY_COL_DEADLINE = intFromEnv('DELIVERY_COL_DEADLINE', 0) // A列: 納品〆切
export const DELIVERY_COL_URL = intFromEnv('DELIVERY_COL_URL', 3) //          D列: 納品URL
// 先頭の見出し行を読み飛ばす行数。既定1（1行目が「納品〆切, 本数, 動画のNo, 納品URL」の見出し）。
export const DELIVERY_HEADER_ROWS = intFromEnv('DELIVERY_HEADER_ROWS', 1)
