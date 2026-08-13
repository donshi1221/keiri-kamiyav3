import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { asc, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { expenseUploads, expenseUploadItems } from '@/lib/schema'
import type { ExpenseUploadRow } from '@/lib/ui-types'

// 受け付けた経費ファイルの一覧（明細込み）。
// 既定は代表が送信済み（submitted）の分だけ＝経理が今まさに登録可否を判断する対象。
// 過去の登録・却下まで見たいときは ?status=all を付ける。
// 原本（file_data）は1件で数MBになりうるため列ごと除外し、必要なときだけ
// /api/expense-uploads/[id]/file から取り出す。
export async function GET(req: NextRequest) {
  try {
    const all = req.nextUrl.searchParams.get('status') === 'all'

    const rows = await db.query.expenseUploads.findMany({
      columns: { file_data: false },
      where: all ? undefined : eq(expenseUploads.status, 'submitted'),
      orderBy: [desc(expenseUploads.created_at)],
      with: {
        items: {
          // 日付が読めない行もあるため、日付順ではなく原本の並び順で出す。
          orderBy: [asc(expenseUploadItems.sort_order)],
          with: { clients: { columns: { name: true } } },
        },
      },
    })

    // クライアント名は画面の表示にしか使わないので、入れ子のまま返さず行に平らに載せる
    // （画面側が items[].clients?.name のような分岐を書かずに済む）。
    const data: ExpenseUploadRow[] = rows.map((row) => ({
      ...row,
      items: row.items.map(({ clients, ...item }) => ({ ...item, client_name: clients?.name ?? null })),
    }))

    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}
