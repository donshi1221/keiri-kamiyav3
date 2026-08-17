import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from './db'
import { expenseUploads, monthlyGlobalTasks } from './schema'
import { nowJST } from './dates'

// 経理が最後の1件を処理し終えた時点で、当月のグローバルタスク「社長経費確認」に自動でチェックを入れる。
// 経費チェック画面が空になった＝そのタスクは終わっているのに、ダッシュボードで人が押し直すまで
// 未完了のまま残り、期日の催促だけが飛ぶという食い違いを無くすのが目的。
// 戻り値は「この操作でチェックが入ったか」。既にチェック済み・未処理が残っているときは false。
export async function autoCheckExpenseTaskIfCleared(): Promise<boolean> {
  const [pending] = await db
    .select({ count: sql<number>`count(*)` })
    .from(expenseUploads)
    // draft（代表が割当中）と submitted（経理の確認待ち）が経理から見た「未処理」。
    .where(inArray(expenseUploads.status, ['draft', 'submitted']))
  if (Number(pending.count) > 0) return false

  const today = nowJST()
  const year = today.getFullYear()
  const month = today.getMonth() + 1

  // 行が無い月でも動くように、cron（lib/monthly-records）と同じ形で作ってから更新する。
  // cron の生成が漏れた月に経費だけ片付いた場合、行が無いことを理由に自動チェックが
  // 効かないのは分かりづらいため。
  await db.insert(monthlyGlobalTasks).values({ year, month }).onConflictDoNothing()

  // 判定と更新の間に別の操作が割り込んでも、同じ列に日時がもう一度入るだけで実害が無いため排他はしない。
  const updated = await db
    .update(monthlyGlobalTasks)
    .set({ expense_confirmed_at: new Date().toISOString() })
    .where(
      and(
        eq(monthlyGlobalTasks.year, year),
        eq(monthlyGlobalTasks.month, month),
        // 既にチェック済みなら日時を上書きしない（人が確認した時刻を残すため）。
        isNull(monthlyGlobalTasks.expense_confirmed_at)
      )
    )
    .returning({ id: monthlyGlobalTasks.id })

  return updated.length > 0
}
