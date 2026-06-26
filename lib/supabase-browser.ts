import { createBrowserClient } from '@supabase/ssr'
import { Database } from './database.types'

// クライアントコンポーネント（ブラウザ）専用クライアント
// 公開キー（anon key）を使う。RLSポリシーの範囲内でのみ操作可能
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Supabase env vars are not configured')
  return createBrowserClient<Database>(url, key)
}
