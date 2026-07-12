// セッショントークンは「失効時刻(ミリ秒).その署名」の形式にする。
// 旧実装は固定文字列を署名しただけで全員共通・永久に不変だったため、
// 値が漏れると永久に有効になってしまう。失効時刻を埋め込み署名することで、
// 期限切れトークンを proxy.ts 側で確実に無効化できる。

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// 失効時刻を埋め込んだ署名付きトークンを生成する。
export async function createSessionToken(secret: string, ttlMs: number): Promise<string> {
  const expiresAt = String(Date.now() + ttlMs)
  const signature = await hmacHex(secret, expiresAt)
  return `${expiresAt}.${signature}`
}

// 署名が正しく、かつ失効時刻を過ぎていなければ true を返す。
export async function verifySessionToken(secret: string, token: string): Promise<boolean> {
  const dot = token.indexOf('.')
  if (dot < 0) return false

  const expiresAt = token.slice(0, dot)
  const signature = token.slice(dot + 1)

  const expected = await hmacHex(secret, expiresAt)
  if (!timingSafeEqual(signature, expected)) return false

  const exp = Number(expiresAt)
  if (!Number.isFinite(exp) || Date.now() > exp) return false

  return true
}
