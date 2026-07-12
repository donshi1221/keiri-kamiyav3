import type { Config } from 'drizzle-kit'
import { loadEnvConfig } from '@next/env'

// drizzle-kit は Next.js の外で動くため .env.local を自動では読まない。
// アプリ本体と同じ読み込み規則（.env.local 優先）を再現して DATABASE_URL を解決する。
loadEnvConfig(process.cwd())

export default {
  schema: './lib/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config
