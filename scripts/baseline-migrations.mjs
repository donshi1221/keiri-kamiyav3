// 既存の本番DB（db:push で作られ、drizzle のマイグレーション管理外のまま運用されているDB）を
// 「ベースライン登録」するための一度きりのスクリプト。
//
// なぜ必要か:
//   drizzle-kit migrate は drizzle.__drizzle_migrations テーブルを見て「どこまで適用済みか」を判断する。
//   本番DBにはこのテーブルが無いため、そのまま db:migrate すると 0000（全テーブルの CREATE TABLE）から
//   流そうとして「テーブルが既に存在する」で失敗する。
//   そこで、0000 を「適用済み」として記録し、以後は 0001 以降だけが適用されるようにする。
//
// このスクリプトは SQL マイグレーションを一切実行しない。__drizzle_migrations に1行入れるだけ。
//
// 使い方:  node scripts/baseline-migrations.mjs
//   （.env.local の DATABASE_URL が本番を指していることを確認してから実行する）

import { neon } from '@neondatabase/serverless'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL が未設定です。.env.local を確認してください。')
  process.exit(1)
}

// drizzle 自身の読み取りでハッシュを算出する（手計算だと改行コード差などでズレるため）。
const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
if (migrations.length === 0) {
  console.error('drizzle/ にマイグレーションが見つかりません。先に npm run db:generate を実行してください。')
  process.exit(1)
}
const baseline = migrations[0] // 0000（現状スキーマのベースライン）

const sql = neon(url)

await sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`
await sql`CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
)`

// 既に何か記録済みなら誤操作を避けるため何もしない（ベースラインは空の状態でのみ登録する）。
const rows = await sql`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`
if (rows[0].n > 0) {
  console.log('既に __drizzle_migrations にレコードが存在するため、何もしません（登録済みとみなします）。')
  process.exit(0)
}

await sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
          VALUES (${baseline.hash}, ${baseline.folderMillis})`
console.log(`ベースライン登録が完了しました: ${baseline.hash}`)
console.log('以後は npm run db:migrate で 0001 以降のみが適用されます。')
