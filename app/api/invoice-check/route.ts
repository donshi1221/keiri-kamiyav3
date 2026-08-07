import { serverError } from '@/lib/api-error'
import { db } from '@/lib/db'
import { contractors, invoiceUploads } from '@/lib/schema'
import { asc, desc, eq, sql } from 'drizzle-orm'

// 受け付けた請求書の一覧。
// PDF本体（file_data）は1件で数MBになりうるため列ごと除外し、必要なときだけ
// /api/invoice-check/[id]/pdf から取り出す。
// 委託者名は照合で特定したIDを引き当てたもの（未特定なら null）。
export async function GET() {
  try {
    const rows = await db
      .select({
        id: invoiceUploads.id,
        contractor_id: invoiceUploads.contractor_id,
        contractor_name: contractors.name,
        file_name: invoiceUploads.file_name,
        status: invoiceUploads.status,
        extracted_amount: invoiceUploads.extracted_amount,
        extracted_issuer: invoiceUploads.extracted_issuer,
        extracted_addressee: invoiceUploads.extracted_addressee,
        extracted_year: invoiceUploads.extracted_year,
        extracted_month: invoiceUploads.extracted_month,
        extract_error: invoiceUploads.extract_error,
        extracted_at: invoiceUploads.extracted_at,
        resolved_year: invoiceUploads.resolved_year,
        resolved_month: invoiceUploads.resolved_month,
        expected_amount: invoiceUploads.expected_amount,
        check_notes: invoiceUploads.check_notes,
        checked_at: invoiceUploads.checked_at,
        created_at: invoiceUploads.created_at,
      })
      .from(invoiceUploads)
      .leftJoin(contractors, eq(invoiceUploads.contractor_id, contractors.id))
      // 人の対応が要る行（NG・保留）を先頭に出す。放置すると支払いが止まるのはこの2つだけで、
      // 件数が増えるほど新しい順だけでは埋もれてしまうため。同じ区分の中は新しい順。
      .orderBy(
        asc(sql`case when ${invoiceUploads.status} in ('ng', 'hold') then 0 else 1 end`),
        desc(invoiceUploads.created_at)
      )
    return Response.json(rows)
  } catch (err) {
    return serverError(err)
  }
}
