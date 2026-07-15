import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

// DB接続はモジュール読み込み時ではなく「最初に使われた時」に作る（遅延初期化）。
// 理由: Next.jsのビルド（ページデータ収集）ではDATABASE_URLが無く、トップレベルで
// neon() を呼ぶと「接続文字列が無い」でビルドが落ちるため、実行時まで生成を遅らせる。
type DbClient = ReturnType<typeof drizzle<typeof schema>>

let cached: DbClient | null = null
function getDb(): DbClient {
  if (!cached) cached = drizzle(neon(process.env.DATABASE_URL!), { schema })
  return cached
}

// 外から見た使い勝手（db.query... / db.select() / db.insert() 等）は変えずに、
// 実際のプロパティアクセス時に初めて接続を生成する。
export const db = new Proxy({} as DbClient, {
  get(_t, prop, receiver) {
    const real = getDb()
    const value = Reflect.get(real as object, prop, receiver)
    return typeof value === 'function' ? value.bind(real) : value
  },
})
