import 'server-only'

import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { appSettings } from '@/lib/schema'
import { timingSafeEqual } from '@/lib/auth'

// 請求書受付URL（/invoice/<トークン>）のトークンを扱う。
// トークンは全員共通の1本で、これを知っている人だけがアップロードできる「合言葉」になる。
// app_settings のこのキーに保存し、画面から再発行（上書き）できるようにしている。
const INVOICE_UPLOAD_TOKEN_KEY = 'invoice_upload_token'

// 総当たりで当てられないよう、32バイト（256ビット）の乱数を16進文字列にする。
function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function readToken(): Promise<string | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, INVOICE_UPLOAD_TOKEN_KEY))
  return row?.value ?? null
}

// 現在のトークンを返す。未発行なら発行して保存してから返す。
export async function getOrCreateInvoiceUploadToken(): Promise<string> {
  const existing = await readToken()
  if (existing) return existing

  // 同時アクセスで二重に発行しても、先に入った値を正として読み直す。
  // 後勝ちで上書きすると、直前に配ったURLが理由もなく無効になってしまうため。
  await db
    .insert(appSettings)
    .values({ key: INVOICE_UPLOAD_TOKEN_KEY, value: generateToken() })
    .onConflictDoNothing()
  return (await readToken()) ?? ''
}

// トークンを作り直して保存する（＝再発行）。古いURLはこの時点で無効になる。
export async function reissueInvoiceUploadToken(): Promise<string> {
  const token = generateToken()
  await db
    .insert(appSettings)
    .values({ key: INVOICE_UPLOAD_TOKEN_KEY, value: token })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: token, updated_at: new Date().toISOString() },
    })
  return token
}

// 受け取ったトークンが現在のものと一致するか。
// 未発行のときに発行してしまうと、無関係な訪問者のアクセスでURLが確定してしまうため、ここでは作らない。
export async function verifyInvoiceUploadToken(token: string): Promise<boolean> {
  if (!token) return false
  const current = await readToken()
  if (!current) return false
  // 文字列比較の所要時間からトークンを1文字ずつ推測されないよう、長さに依らず一定時間で比較する。
  return timingSafeEqual(token, current)
}
