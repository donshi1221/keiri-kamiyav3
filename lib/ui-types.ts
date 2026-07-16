import type {
  MonthlyRecord,
  MonthlyClientRecord,
  Assignment,
  Contractor,
  Client,
  ClientBillingItem,
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

// 「今日やること」の1項目。クライアント系（請求書送付・入金確認）は件数が多くなるため、
// group を付けてグループ単位の折りたたみ表示にする。group なしは従来どおり個別表示。
export type TaskGroup = 'clientInvoice' | 'clientPayment'
export interface TaskItem {
  label: string
  group?: TaskGroup
}

// monthlyClientRecords（クライアント請求記録）。
// billing_item_id / label_snapshot は MonthlyClientRecord 本体に含まれる。
// billing_items（内訳マスタ）はダッシュボードのみ取得（回数超過の判定に contract_months を使う）。
// 履歴側は内訳マスタまでは取らないため任意。
export type ClientRecordWithClient = MonthlyClientRecord & {
  clients: Pick<Client, 'id' | 'name'> | null
  billing_items?: Pick<ClientBillingItem, 'id' | 'label' | 'contract_months'> | null
}
