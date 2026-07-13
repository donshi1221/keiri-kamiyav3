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
