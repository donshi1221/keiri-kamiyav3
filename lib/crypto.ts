import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// 秘密情報（MoneyForwardのアクセストークン等）をDBに保存する前に暗号化する共通処理。
// AES-256-GCM を使い、鍵は環境変数 ENCRYPTION_KEY（32バイト）から取る。
// 保存形式: "gcmv1:" + base64(iv[12] | authTag[16] | ciphertext)
//   - iv     : 毎回ランダム（同じ平文でも毎回別の暗号文になる）
//   - authTag: 改ざん検知用のタグ（復号時に検証、壊れていれば例外）
// 先頭マーカーで「暗号化済みか」を判別でき、旧・平文データは復号時に弾かれる（→再連携を促す）。

const PREFIX = 'gcmv1:'
const IV_BYTES = 12
const TAG_BYTES = 16

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY is not set')
  // 64文字なら16進、それ以外はbase64として解釈する。いずれも32バイトに復号できる必要がある。
  const key = raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to 32 bytes (use e.g. `openssl rand -base64 32`)')
  }
  return key
}

export function isEncryptionConfigured(): boolean {
  return !!process.env.ENCRYPTION_KEY
}

export function encryptSecret(plain: string): string {
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) {
    // 旧・平文データ、または想定外の形式。安全側に倒して例外にする。
    throw new Error('value is not encrypted (legacy plaintext?)')
  }
  const key = getKey()
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64')
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const enc = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
