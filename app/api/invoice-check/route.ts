import { serverError } from '@/lib/api-error'
import { db } from '@/lib/db'
import { invoiceUploads } from '@/lib/schema'
import { desc } from 'drizzle-orm'

// 受け付けた請求書の一覧（新しい順）。
// PDF本体（file_data）は1件で数MBになりうるため列ごと除外し、必要なときだけ
// /api/invoice-check/[id]/pdf から取り出す。
export async function GET() {
  try {
    const rows = await db
      .select({
        id: invoiceUploads.id,
        contractor_id: invoiceUploads.contractor_id,
        file_name: invoiceUploads.file_name,
        status: invoiceUploads.status,
        extracted_amount: invoiceUploads.extracted_amount,
        extracted_issuer: invoiceUploads.extracted_issuer,
        extracted_addressee: invoiceUploads.extracted_addressee,
        extracted_year: invoiceUploads.extracted_year,
        extracted_month: invoiceUploads.extracted_month,
        extract_error: invoiceUploads.extract_error,
        extracted_at: invoiceUploads.extracted_at,
        created_at: invoiceUploads.created_at,
      })
      .from(invoiceUploads)
      .orderBy(desc(invoiceUploads.created_at))
    return Response.json(rows)
  } catch (err) {
    return serverError(err)
  }
}
