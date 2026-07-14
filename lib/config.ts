// アプリ全体で使う「設定値」を1か所に集約する。
// 秘密情報（APIキー等）は .env のまま扱い、ここには「振る舞いを決める値」だけを置く。
// 環境変数で上書きでき、未設定時は既定値を使う。

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// 税務AIチャットで使う Gemini のモデル名。
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'

// 税務アドバイスのファイルアップロード上限（バイト）。既定 5MB。
export const UPLOAD_MAX_BYTES = intFromEnv('UPLOAD_MAX_BYTES', 5 * 1024 * 1024)

// 月次生成cronが何日成功していなければ「止まっている疑い」とみなすか。既定35日（1か月分の未実行を検知）。
export const CRON_STALE_ALERT_DAYS = intFromEnv('CRON_STALE_ALERT_DAYS', 35)

// 「その他経費」に含めるMF勘定科目（コードまたは名前）。外注費は含めない。
export const MF_EXPENSE_ACCOUNTS = (process.env.MF_EXPENSE_ACCOUNTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
