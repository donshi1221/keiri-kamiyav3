import { createClient } from '@supabase/supabase-js'
import { Database } from './database.types'

// サーバーサイド（APIルート・Cron）専用クライアント
// サービスロールキーを使うため RLS をバイパスできる（ブラウザに渡してはいけない）
export function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}
