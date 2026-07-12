import type {
  MonthlyRecord,
  MonthlyClientRecord,
  Assignment,
  Contractor,
  Client,
} from './schema'

// ダッシュボード（app/page.tsx）と履歴（app/history/page.tsx）で共通に使う
// 「月次レコード + リレーション」の型。以前は両コンポーネントに別々にコピペされ、
// 実クエリと形が食い違ったまま `as any` で握りつぶされていた。
// 実際のクエリが columns 指定で取得する形にここで正確に一致させ、as any を不要にする。

// monthlyRecords（両画面のクエリは同一）
export type RecordWithRelations = MonthlyRecord & {
  assignments: (Assignment & {
    contractors: Pick<Contractor, 'id' | 'name' | 'contractor_type'> | null
    clients: Pick<Client, 'id' | 'name'> | null
  }) | null
}

// monthlyClientRecords。contract_start / contract_months はダッシュボードのみ
// 取得するため任意（履歴側は billing_amount までしか取らない）。
export type ClientRecordWithClient = MonthlyClientRecord & {
  clients: (Pick<Client, 'id' | 'name' | 'billing_amount'> & {
    contract_start?: string | null
    contract_months?: number | null
  }) | null
}
