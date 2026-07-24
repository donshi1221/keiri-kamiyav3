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
    // unit_price は納品チェックの結果から実支払額（本数×単価）を出すために取得する。
    contractors: Pick<Contractor, 'id' | 'name' | 'contractor_type' | 'unit_price'> | null
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

// ─── 納品チェック（app/delivery）─────────────────────────────
// 編集者スプレッドシートを読んで「対象月に納品すべき本数／実際に納品済みの本数」を数えた結果の1行。
// システムはDBに書き込まず、この集計結果を表示するだけ（合否判定・請求書との照合は人が行う）。
export type DeliveryCheckStatus =
  | 'ok' //            集計成功
  | 'no_url' //        アサインにスプレッドシートURLが未登録
  | 'bad_url' //       URLからスプレッドシートIDを取り出せない
  | 'no_tab' //        対象月のタブが見つからない
  | 'ambiguous_tab' // 対象月に一致するタブが複数あり特定できない
  | 'no_api_key' //    GOOGLE_SHEETS_API_KEY 未設定
  | 'forbidden' //     非公開シート or APIキー権限不足で読めない
  | 'fetch_error' //   その他の取得失敗

export interface DeliveryCheckRow {
  assignmentId: string
  contractorName: string
  clientName: string
  roleName: string
  spreadsheetUrl: string | null
  status: DeliveryCheckStatus
  tabTitle: string | null //  実際に読んだタブ名（例:「6月度」）
  expected: number | null //  納品すべき本数（A列の〆切が対象月の行数）
  delivered: number | null // 納品済み本数（うちD列にURLがある行数）
  message: string | null //   補足・エラー内容（人間向け）
}
