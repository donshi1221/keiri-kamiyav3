import 'server-only'

// APIの想定外エラー（catch節）を扱う共通ヘルパー。
// err.message をそのままレスポンスに載せると、DB構造・接続情報・スタックなどの
// 内部情報が利用者に漏れうる。詳細はサーバーログにだけ出し、クライアントには
// 内部情報を含まない汎用メッセージだけを返す。
export function serverError(err: unknown, context?: string): Response {
  console.error(context ? `[${context}]` : '[api]', err)
  return Response.json(
    { error: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。' },
    { status: 500 }
  )
}
