import { serverError } from '@/lib/api-error'
import { db } from '@/lib/db'
import {
  contractors,
  clients,
  clientBillingItems,
  assignments,
  monthlyRecords,
  monthlyClientRecords,
  monthlyGlobalTasks,
  monthlyCustomGlobalTasks,
  taxAdviceEntries,
  taxChatSessions,
  taxChatMessages,
  moneyforwardExpenses,
} from '@/lib/schema'
import { nowJST } from '@/lib/dates'

// 全テーブルを走査してJSONにまとめるため、既定の短いタイムアウトだと足りない可能性がある。
export const maxDuration = 60

// 全データをJSONでダウンロードするオンデマンドバックアップ。
// proxy.ts で認証必須。moneyforward_tokens は秘密情報のため意図的に含めない
// （復旧時は再連携すればよく、平文バックアップに秘密を残さない）。
export async function GET() {
  try {
    const [
      contractorsData,
      clientsData,
      clientBillingItemsData,
      assignmentsData,
      monthlyRecordsData,
      monthlyClientRecordsData,
      monthlyGlobalTasksData,
      monthlyCustomGlobalTasksData,
      taxAdviceEntriesData,
      taxChatSessionsData,
      taxChatMessagesData,
      moneyforwardExpensesData,
    ] = await Promise.all([
      db.select().from(contractors),
      db.select().from(clients),
      db.select().from(clientBillingItems),
      db.select().from(assignments),
      db.select().from(monthlyRecords),
      db.select().from(monthlyClientRecords),
      db.select().from(monthlyGlobalTasks),
      db.select().from(monthlyCustomGlobalTasks),
      db.select().from(taxAdviceEntries),
      db.select().from(taxChatSessions),
      db.select().from(taxChatMessages),
      db.select().from(moneyforwardExpenses),
    ])

    const now = nowJST()
    const dump = {
      exportedAt: now.toISOString(),
      schemaVersion: 1,
      tables: {
        contractors: contractorsData,
        clients: clientsData,
        client_billing_items: clientBillingItemsData,
        assignments: assignmentsData,
        monthly_records: monthlyRecordsData,
        monthly_client_records: monthlyClientRecordsData,
        monthly_global_tasks: monthlyGlobalTasksData,
        monthly_custom_global_tasks: monthlyCustomGlobalTasksData,
        tax_advice_entries: taxAdviceEntriesData,
        tax_chat_sessions: taxChatSessionsData,
        tax_chat_messages: taxChatMessagesData,
        moneyforward_expenses: moneyforwardExpensesData,
      },
    }

    const filename = `keiri-backup-${now.toISOString().slice(0, 10)}.json`
    return new Response(JSON.stringify(dump, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return serverError(err, 'backup/export')
  }
}
