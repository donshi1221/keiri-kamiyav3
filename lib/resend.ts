import { Resend } from 'resend'

// メール送信クライアント（遅延初期化パターン）
// APIルート内で都度 getResend() を呼ぶ。モジュールロード時に初期化しないことで
// 環境変数未設定でもビルドが通る
export function getResend() {
  return new Resend(process.env.RESEND_API_KEY)
}
