import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { checkAssignmentDelivery } from '@/lib/sheets'
import type { DeliveryCheckRow } from '@/lib/ui-types'

// 外部スプレッドシートを編集者の数だけ読むため、既定より長めの実行時間を許可する。
export const maxDuration = 60

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams
    const year = Number(searchParams.get('year'))
    const month = Number(searchParams.get('month'))
    if (
      !Number.isInteger(year) || year < 2000 || year > 2100 ||
      !Number.isInteger(month) || month < 1 || month > 12
    ) {
      return Response.json({ error: 'year / month の指定が不正です' }, { status: 400 })
    }

    // 動画編集者のアクティブなアサインを対象にする。URL未登録も結果に「未登録」として出し、
    // 貼り忘れ（＝集計漏れ）が見えるようにする。
    const all = await db.query.assignments.findMany({
      with: {
        contractors: { columns: { id: true, name: true, contractor_type: true } },
        clients: { columns: { id: true, name: true } },
      },
    })
    const targets = all.filter((a) => a.active && a.contractors?.contractor_type === 'video_editor')

    // 各シートは独立に読めるので並行取得する（各失敗は checkAssignmentDelivery 内で状態化され、全体は止まらない）。
    const rows: DeliveryCheckRow[] = await Promise.all(
      targets.map((a) =>
        checkAssignmentDelivery(
          {
            assignmentId: a.id,
            contractorName: a.contractors?.name ?? '?',
            clientName: a.clients?.name ?? '?',
            roleName: a.role_name,
            spreadsheetUrl: a.spreadsheet_url,
          },
          month
        )
      )
    )

    // 「要確認（ok以外）」を上に、その中は編集者名の五十音順で並べる。
    rows.sort((x, y) => {
      const ox = x.status === 'ok' ? 1 : 0
      const oy = y.status === 'ok' ? 1 : 0
      if (ox !== oy) return ox - oy
      return x.contractorName.localeCompare(y.contractorName, 'ja')
    })

    return Response.json({ year, month, rows })
  } catch (err) {
    return serverError(err)
  }
}
