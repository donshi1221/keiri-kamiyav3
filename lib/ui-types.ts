import type {
  MonthlyRecord,
  MonthlyClientRecord,
  Assignment,
  Contractor,
  Client,
  ClientBillingItem,
  InvoiceUpload,
} from './schema'

// ダッシュボード（app/page.tsx）が使う「月次レコード + リレーション」の型。
// 以前はコンポーネント側にコピペされ、実クエリと形が食い違ったまま `as any` で握りつぶされていた。
// 実際のクエリが columns 指定で取得する形にここで正確に一致させ、as any を不要にする。

// monthlyRecords
export type RecordWithRelations = MonthlyRecord & {
  assignments: (Assignment & {
    // unit_price は納品チェックの結果から実支払額（本数×単価）を出すために取得する。
    contractors: Pick<Contractor, 'id' | 'name' | 'contractor_type' | 'unit_price'> | null
    clients: Pick<Client, 'id' | 'name'> | null
  }) | null
}

// 「今日やること」の1項目。委託者系・クライアント系は人数×アサイン数だけ項目が増え、
// 同じ作業の行が縦に延々と並んでしまうため、group を付けて作業ごとに1グループへまとめる
// （グループ内は名前チップの横並び）。group なしの単発・全社タスクは従来どおり個別行で出す。
export type TaskGroup =
  | 'contractorInvoice'
  | 'contractorReserve'
  | 'contractorPaid'
  | 'clientInvoice'
  | 'clientPayment'
export interface TaskItem {
  label: string
  group?: TaskGroup
  // 対応する行の data-pending-row の値。項目タップでその行へ飛ばすために持たせる。
  target?: string
}

// monthlyClientRecords（クライアント請求記録）。
// billing_item_id / label_snapshot は MonthlyClientRecord 本体に含まれる。
// billing_items（内訳マスタ）は回数超過の判定に contract_months を使うために取得する。
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
  // 該当月タブを直接開くURL。タブを特定できたときだけ入る（未特定時は spreadsheetUrl で代用する）。
  tabUrl: string | null
  expected: number | null //  納品すべき本数（A列の〆切が対象月の行数）
  delivered: number | null // 納品済み本数（うちD列にURLがある行数）
  message: string | null //   補足・エラー内容（人間向け）
}

// ─── 請求書チェック（app/invoice-check）─────────────────────────────
// AI読み取り（lib/invoice-extract）の成功結果。列名（extracted_*）ではなく短い名前にして、
// AIに返させるJSONのキーと1対1に対応させる。
export interface InvoiceExtracted {
  amount: number | null
  issuer: string | null
  addressee: string | null
  year: number | null
  month: number | null
  // 明細行。内訳が書かれていない請求書では空配列になる（＝合計だけで照合する）。
  items: InvoiceExtractedItem[]
}

// 請求書の明細1行。列の型（lib/schema）から派生させ、DBに入る形と画面・照合で扱う形を必ず一致させる。
export type InvoiceExtractedItem = NonNullable<InvoiceUpload['extracted_items']>[number]

// 明細の種別。work（業務の対価）はクライアント別の支払予定と、expense（交通費などの実費・立替）は
// 登録済みの立替経費と照合する。列の型から派生させ、AIに返させる値と照合の分岐を1か所に揃える。
export type InvoiceItemKind = NonNullable<InvoiceExtractedItem['kind']>

// 支払予定額のアサイン別内訳1行。合計だけでは「どのクライアントでズレたか」が出せないため、
// 照合（lib/invoice-check）が請求書の明細と突き合わせる相手として使う。
// count は編集者の本数。代行者は契約額での支払いで本数の概念が無いため null になる。
// matchNames は明細ラベルの中から探す呼び名の候補（正式名・法人格を外した形・別名）。
// 表示に使う clientName は正式名のままにしたいので、照合用の名前は別に持たせる。
// paymentStartMonth / paymentCount はマスタのアサインに登録された支払期間（開始年月と支払回数）。
// 明細に書かれる「19/24」（全24回中19回目）が支払予定と合っているかは、この期間から導いた
// 契約終了月と突き合わせないと判定できないため、内訳の行に持たせる。
// どちらかが未設定の行は「継続」（回数の定めなし）＝突き合わせる相手が無いので null になる。
// nmAsDate はそのクライアントの「N/M」の読み方（clients.nm_as_date）。回数として読むか
// 日付として読むかは明細を当てたクライアントが決まらないと判断できないため、内訳の行に持たせる。
export interface InvoicePayoutBreakdownRow {
  clientName: string
  count: number | null
  amount: number
  matchNames: string[]
  paymentStartMonth: string | null
  paymentCount: number | null
  nmAsDate: boolean
}

// 読み取りは失敗しても例外にせず、理由を持ち回って extract_error に保存する。
export type InvoiceExtractOutcome = InvoiceExtracted | { error: string }

// 編集者の納品スプレッドシートへの導線1件。NGの原因は本数ズレが多く、実本数はシートを見ないと分からない。
// マスタ→アサインと辿らないとURLに到達できなかったため、一覧の行から直接開けるように持たせる。
export interface InvoiceDeliverySheetLink {
  clientName: string
  url: string
}

// 経費のその場登録で選ぶ「登録先アサイン」1件。画面側で明細ラベルからクライアントを推定して
// 初期選択するため、表示用の正式名とは別に照合用の呼び名（matchNames）も持たせる。
export interface InvoiceExpenseAssignment {
  id: string
  clientName: string
  matchNames: string[]
}

// 一覧APIが返す1行。PDF本体（file_data）は重いので一覧には載せず、
// 表示が必要なときだけ /api/invoice-check/[id]/pdf から取り出す。
// contractor_name は照合で特定した委託者名。IDだけでは画面で誰か分からないため結合して持たせる。
// delivery_sheets は編集者のときだけ入る（委託者未特定・代行者・URL未登録なら空配列）。
// payout_year / payout_month は照合に使った支払月（記載月の翌月）。経費は支払月の行に登録する
// 決まりなので、画面側で月をずらす計算をやり直さずに済むようサーバーで確定させて渡す。
// expense_assignments は経費の登録先候補（その委託者のアクティブなアサイン）。
export type InvoiceCheckRow = Omit<InvoiceUpload, 'file_data'> & {
  contractor_name: string | null
  delivery_sheets: InvoiceDeliverySheetLink[]
  payout_year: number | null
  payout_month: number | null
  expense_assignments: InvoiceExpenseAssignment[]
}

// 自動照合（lib/invoice-check）の判定結果。DBの列と1対1に対応させ、
// 保存する値と画面へ返す値がズレないようにする。
export type InvoiceCheckStatus = InvoiceUpload['status']

export interface InvoiceCheckResult {
  status: InvoiceCheckStatus
  contractorId: string | null
  resolvedYear: number | null
  resolvedMonth: number | null
  expectedAmount: number | null
  // 判定理由（観点ごとに1行）。保存時に改行で連結して check_notes に入れる。
  // 各行の先頭には印（lib/invoice-notes）が付き、画面はそれを見て出し分ける。
  notes: string[]
}

// 判定理由1行の意味づけ。ok/ng/hold は判定そのもの、received/fixed/saved は
// 「判定の結果として何をしたか」の記録で、判定の色分けとは別扱いにする。
// saveFailed だけは記録でありながら人の対応（再チェック）を促すため、警告として見せる。
// caution は判定（ok/ng/hold）とは独立の注意喚起。明細の支払回数（「19/24」）が支払予定と
// 合わないときのように、判定を変えずに「人が確認して」と伝えるためだけに使う。
export type InvoiceNoteMark = 'ok' | 'ng' | 'hold' | 'caution' | 'received' | 'fixed' | 'saved' | 'saveFailed'

// 印を外したあとの1行。印を付ける前に保存された行もあるため mark は null を取りうる。
export interface InvoiceNoteLine {
  mark: InvoiceNoteMark | null
  text: string
}

// AIの読み取り結果を人が直すときに送る値。読み取れなかった項目を空欄のまま保存できるよう、
// すべて null を許す（0 や空文字に丸めると「そう書いてあった」と区別が付かなくなる）。
export interface InvoiceExtractedPatch {
  extracted_amount: number | null
  extracted_issuer: string | null
  extracted_addressee: string | null
  extracted_year: number | null
  extracted_month: number | null
}

// ダッシュボードの注意カード用の件数。人の対応が必要な区分だけを数える
// （ok は対応不要。全件okならカード自体を出さないため、この型ごと null になる）。
export interface InvoiceAlertCounts {
  ng: number
  hold: number
  pending: number
}

// 読み取りに失敗している行は照合できない（判定材料が無い）ため、status を pending のまま据え置く。
// 「照合したが保留」と区別できるよう、実行しなかったことを理由付きで返す。
export type InvoiceCheckOutcome = InvoiceCheckResult | { skipped: string }

// ─── Googleドライブ保存（lib/google-drive）─────────────────────────────
// disabled は「環境変数が未設定＝この機能を使わない運用」。失敗(error)と区別できないと、
// 機能を使っていない人にまで保存失敗の記録が出てしまうため、別の値として返す。
// 設定済みなのに未連携・連携切れの場合は disabled ではなく error（＝画面に理由と次の操作が出る）。
// folderName は保存先の月別サブフォルダ名。判定理由に載せて「どこに入ったか」を画面から分かるようにする。
export type DriveUploadOutcome =
  | { fileId: string; link: string; folderName: string }
  | { error: string }
  | { disabled: true }

// GET /api/google-drive/status の応答。configured は環境変数が揃っているか、
// connected は実際に有効なアクセストークンを取れるか。行はあるが更新できない（＝連携切れ）状態を
// 「未連携」と同じ表示にしないため、両方を分けて返す。
export interface GoogleDriveStatus {
  configured: boolean
  connected: boolean
  updatedAt: string | null
}
