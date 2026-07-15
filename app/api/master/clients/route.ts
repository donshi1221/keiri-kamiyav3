import { serverError } from '@/lib/api-error'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clients } from '@/lib/schema'
import { asc } from 'drizzle-orm'
import { parseBody, clientCreateSchema } from '@/lib/validation'

export async function GET() {
  try {
    // クライアントと請求内訳（billing_items）をまとめて返す。内訳は表示順→作成順で並べる。
    const data = await db.query.clients.findMany({
      orderBy: [asc(clients.created_at)],
      with: {
        billing_items: {
          orderBy: (bi, { asc }) => [asc(bi.sort_order), asc(bi.created_at)],
        },
      },
    })
    return Response.json(data)
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = parseBody(clientCreateSchema, await req.json())
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 })
    const body = parsed.data
    // クライアント本体のみ作成する。金額・契約期間を持つ請求内訳は
    // /api/master/billing-items 経由で別途作成する（フォームが続けて送る）。
    const [data] = await db.insert(clients).values({
      name: body.name,
      contact_person: body.contact_person ?? null,
      notes: body.notes ?? null,
    }).returning()

    return Response.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}
