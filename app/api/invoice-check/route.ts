import { serverError } from '@/lib/api-error'
import { db } from '@/lib/db'
import { assignments, clients, contractors, invoiceUploads } from '@/lib/schema'
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { payoutMonthOf } from '@/lib/invoice-check'
import { clientMatchNames } from '@/lib/invoice-match'
import type { InvoiceDeliverySheetLink, InvoiceExpenseAssignment } from '@/lib/ui-types'

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
        extracted_items: invoiceUploads.extracted_items,
        extract_error: invoiceUploads.extract_error,
        extracted_at: invoiceUploads.extracted_at,
        resolved_year: invoiceUploads.resolved_year,
        resolved_month: invoiceUploads.resolved_month,
        expected_amount: invoiceUploads.expected_amount,
        check_notes: invoiceUploads.check_notes,
        checked_at: invoiceUploads.checked_at,
        drive_file_id: invoiceUploads.drive_file_id,
        drive_link: invoiceUploads.drive_link,
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

    return Response.json(await withExpenseTargets(await withDeliverySheets(rows)))
  } catch (err) {
    return serverError(err)
  }
}

// 経費のその場登録に必要な情報を各行に付ける。
// - payout_year / payout_month: 経費を登録する月＝支払月（記載月の翌月。lib/invoice-check の payoutMonthOf と同じ定義）。
//   画面側で月をずらす計算を再実装すると照合とズレるため、サーバーで確定させて渡す。
// - expense_assignments: 登録先の候補。経費は assignment_id に紐づけるので、委託者のアクティブな
//   アサインを候補として出す。明細ラベルからクライアントを推定できるよう照合用の呼び名も添える。
// 納品シートと同じく、行ごとに引くと件数分のクエリになるためまとめて1回で引いて配る。
async function withExpenseTargets<
  T extends { contractor_id: string | null; resolved_year: number | null; resolved_month: number | null },
>(
  rows: T[]
): Promise<(T & {
  payout_year: number | null
  payout_month: number | null
  expense_assignments: InvoiceExpenseAssignment[]
})[]> {
  const contractorIds = [
    ...new Set(rows.map((r) => r.contractor_id).filter((id): id is string => id !== null)),
  ]

  const assignmentRows = contractorIds.length === 0 ? [] : await db
    .select({
      id: assignments.id,
      contractor_id: assignments.contractor_id,
      clientName: clients.name,
      aliases: clients.aliases,
    })
    .from(assignments)
    .innerJoin(clients, eq(assignments.client_id, clients.id))
    .where(and(inArray(assignments.contractor_id, contractorIds), eq(assignments.active, true)))

  const byContractor = new Map<string, InvoiceExpenseAssignment[]>()
  for (const a of assignmentRows) {
    const entry: InvoiceExpenseAssignment = {
      id: a.id,
      clientName: a.clientName,
      matchNames: clientMatchNames(a.clientName, a.aliases),
    }
    const list = byContractor.get(a.contractor_id)
    if (list) list.push(entry)
    else byContractor.set(a.contractor_id, [entry])
  }
  // DBの並びはロケール依存なので、五十音順はアプリ側で確定させる。
  for (const list of byContractor.values()) {
    list.sort((x, y) => x.clientName.localeCompare(y.clientName, 'ja'))
  }

  return rows.map((r) => {
    // 対象月が決まっていない行（読み取り失敗・未照合）は支払月も出せない。
    const payout =
      r.resolved_year !== null && r.resolved_month !== null
        ? payoutMonthOf(r.resolved_year, r.resolved_month)
        : null
    return {
      ...r,
      payout_year: payout?.year ?? null,
      payout_month: payout?.month ?? null,
      expense_assignments: (r.contractor_id && byContractor.get(r.contractor_id)) || [],
    }
  })
}

// 編集者の納品シートURLを各行に付ける。NGの多くは本数ズレで、確かめるにはシートを開く必要があるため。
// 行ごとに引くと件数分のクエリになるので、一覧に出てくる委託者をまとめて1回で引き、メモリ上で配る。
async function withDeliverySheets<T extends { contractor_id: string | null }>(
  rows: T[]
): Promise<(T & { delivery_sheets: InvoiceDeliverySheetLink[] })[]> {
  const contractorIds = [
    ...new Set(rows.map((r) => r.contractor_id).filter((id): id is string => id !== null)),
  ]

  const links = contractorIds.length === 0 ? [] : await db
    .select({
      contractor_id: assignments.contractor_id,
      clientName: clients.name,
      url: assignments.spreadsheet_url,
    })
    .from(assignments)
    .innerJoin(clients, eq(assignments.client_id, clients.id))
    .innerJoin(contractors, eq(assignments.contractor_id, contractors.id))
    .where(
      and(
        inArray(assignments.contractor_id, contractorIds),
        eq(assignments.active, true),
        // 代行者は納品シートを持たない（契約額での支払いで本数の概念が無い）ため対象外。
        eq(contractors.contractor_type, 'video_editor'),
        isNotNull(assignments.spreadsheet_url)
      )
    )
    .orderBy(asc(clients.name))

  const byContractor = new Map<string, InvoiceDeliverySheetLink[]>()
  for (const link of links) {
    const url = link.url?.trim()
    if (!url) continue // 空文字で保存された過去データはリンクにならないので落とす
    const list = byContractor.get(link.contractor_id)
    if (list) list.push({ clientName: link.clientName, url })
    else byContractor.set(link.contractor_id, [{ clientName: link.clientName, url }])
  }
  // DBの並びはロケール依存なので、五十音順はアプリ側で確定させる。
  for (const list of byContractor.values()) {
    list.sort((x, y) => x.clientName.localeCompare(y.clientName, 'ja'))
  }

  return rows.map((r) => ({
    ...r,
    delivery_sheets: (r.contractor_id && byContractor.get(r.contractor_id)) || [],
  }))
}
