import { NextRequest } from 'next/server'
import { nowJST } from '@/lib/dates'
import { generateMonthlyRecords } from '@/lib/monthly-records'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const today = nowJST()
    const year = today.getFullYear()
    const month = today.getMonth() + 1

    const { assignmentCount, clientCount } = await generateMonthlyRecords(year, month)

    return Response.json({ ok: true, year, month, assignmentCount, clientCount })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Database error' }, { status: 500 })
  }
}
