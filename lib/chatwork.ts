import 'server-only'
import type { ChatworkSendOutcome } from './ui-types'

// Chatworkへのメッセージ送信（API v2）。
// 必要なのは「1つのルームへ1通送る」だけなので、公式SDKを足さず fetch で組み立てる。
// 認証はアカウント固有のAPIトークンをヘッダー（x-chatworktoken）に載せる方式で、OAuthは不要。
// 送信は失敗しても例外を投げず理由を返す（複数人へ順に送るとき、1人の失敗で残りを止めないため）。

const API_BASE = 'https://api.chatwork.com/v2'
const SEND_TIMEOUT_MS = 15000

export function isChatworkConfigured(): boolean {
  return !!process.env.CHATWORK_API_TOKEN
}

// 理由は画面に出て人が読む。外部APIの生エラーは長大なHTMLのこともあるため頭だけ残す。
function shorten(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

// roomId は「その人とのチャットを開いたURLの #!rid の後ろの数字」。
// body はプレースホルダ置換済みの本文（置換は呼び出し元の責務）。
export async function sendChatworkMessage(roomId: string, body: string): Promise<ChatworkSendOutcome> {
  // 秘密情報はデプロイ環境ごとに変わる接続情報のため、config ではなく環境変数から直接読む。
  const token = process.env.CHATWORK_API_TOKEN
  if (!token) return { disabled: true }

  try {
    const res = await fetch(`${API_BASE}/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      headers: {
        'x-chatworktoken': token,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      // URLSearchParams は改行や記号を自動でエスケープするため、本文をそのまま渡せる。
      // Chatwork API v2 は本文のパラメータ名が message ではなく body（間違えると Parameter 'body' is required で拒否される）。
      body: new URLSearchParams({ body }),
      cache: 'no-store',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => null)) as
      | { message_id?: string; errors?: string[] }
      | null
    if (!res.ok) {
      // Chatworkは失敗理由を errors 配列で返す（例: ルームIDが違う・権限が無い）。
      const detail = json?.errors?.join(' / ') || `HTTP ${res.status}`
      return { error: `Chatworkへの送信に失敗しました（${shorten(detail)}）` }
    }
    return { messageId: json?.message_id ?? null }
  } catch (err) {
    return {
      error: `Chatworkへの通信に失敗しました（${shorten(err instanceof Error ? err.message : String(err))}）`,
    }
  }
}
