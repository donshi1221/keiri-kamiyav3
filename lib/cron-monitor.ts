import 'server-only'
import { db } from './db'
import { cronRuns } from './schema'
import { eq } from 'drizzle-orm'

// cron の死活監視。成功のたびに last_success_at を更新し、古くなっていれば「止まっている疑い」を検知する。
// cron_runs テーブルが未マイグレーションの環境でも本来のcron処理を止めないよう、失敗はログのみにする。

export async function recordCronSuccess(name: string): Promise<void> {
  const now = new Date().toISOString()
  try {
    await db.insert(cronRuns)
      .values({ name, last_success_at: now })
      .onConflictDoUpdate({ target: cronRuns.name, set: { last_success_at: now } })
  } catch (err) {
    console.error('[cron-monitor] recordCronSuccess failed (migration pending?):', err)
  }
}

export async function getCronLastSuccess(name: string): Promise<Date | null> {
  try {
    const [row] = await db.select().from(cronRuns).where(eq(cronRuns.name, name))
    return row ? new Date(row.last_success_at) : null
  } catch (err) {
    console.error('[cron-monitor] getCronLastSuccess failed (migration pending?):', err)
    return null
  }
}

// 最終成功からの経過日数がしきい値を超えていれば警告文を返す（記録がまだ無い場合は誤報を避けて null）。
export async function checkCronStale(name: string, staleDays: number, now: Date): Promise<string | null> {
  const last = await getCronLastSuccess(name)
  if (!last) return null
  const elapsedDays = (now.getTime() - last.getTime()) / (24 * 60 * 60 * 1000)
  if (elapsedDays > staleDays) {
    const lastStr = last.toISOString().slice(0, 10)
    return `自動処理「${name}」が ${Math.floor(elapsedDays)} 日間成功していません（最終成功: ${lastStr}）。設定を確認してください。`
  }
  return null
}
