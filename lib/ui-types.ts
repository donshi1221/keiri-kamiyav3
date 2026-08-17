import type {
  MonthlyRecord,
  MonthlyClientRecord,
  Assignment,
  Contractor,
  Client,
  ClientBillingItem,
  InvoiceUpload,
  ExpenseUpload,
  ExpenseUploadItem,
  PayrollRecipient,
  MonthlyPayrollRecord,
} from './schema'
// 選択肢の実体は lib/config（設定値の集約先）にあり、ここでは型を導くためだけに参照する。
// import type なので実行時のimportは生成されず、画面・サーバーのどちらから読んでも副作用が無い。
import type { EXPENSE_ITEM_KINDS } from './config'

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
// applied（納品実績の月次レコードへの書き戻し）も同じ「何をしたか」の記録。受領と分けるのは、
// 受領＝請求書が届いた事実、applied＝金額を反映した事実で、意味が別のため。
// saveFailed だけは記録でありながら人の対応（再チェック）を促すため、警告として見せる。
// caution は判定（ok/ng/hold）とは独立の注意喚起。明細の支払回数（「19/24」）が支払予定と
// 合わないときのように、判定を変えずに「人が確認して」と伝えるためだけに使う。
export type InvoiceNoteMark = 'ok' | 'ng' | 'hold' | 'caution' | 'received' | 'fixed' | 'applied' | 'saved' | 'saveFailed'

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

// ─── 請求書未提出リマインド（Chatwork）─────────────────────────────
// disabled は「CHATWORK_API_TOKEN 未設定＝この機能を使わない運用」。失敗(error)と区別できないと、
// 使っていない人にまで送信失敗が出てしまうため別の値として返す（Googleドライブ保存と同じ流儀）。
// messageId は送信できたことの控え。Chatworkが返さなかった場合でも成功は成功なので null を許す。
export type ChatworkSendOutcome =
  | { messageId: string | null }
  | { error: string }
  | { disabled: true }

// リマインドの送信先候補1人分。hasRoomId が false の人は送りようがないため、
// 画面では選択不可にしたうえで「ルームID未登録」と出し、マスタ登録へ誘導する。
export interface InvoiceReminderTarget {
  contractorId: string
  name: string
  hasRoomId: boolean
}

// GET /api/invoice-reminder の応答。
// invoiceMonth は「何月分の請求書を催促するか」＝表示中の支払月の前月（全委託者「◯月分＝前月業務分」ルール）。
// 画面が月をずらす計算をやり直さずに済むよう、サーバーで確定させて渡す。
export interface InvoiceReminderPlan {
  year: number
  month: number
  invoiceYear: number
  invoiceMonth: number
  targets: InvoiceReminderTarget[]
  // 画面で編集できる文面のたたき台。{name} {month} {url} は送信時にサーバーが置き換える。
  template: string
}

// 送信結果1人分。sent 以外は理由を出す必要があるので、区分と文言を分けて持つ。
// no_room はマスタ未登録（人が直せる）、error は送信そのものの失敗。
export type InvoiceReminderSendStatus = 'sent' | 'no_room' | 'error'

export interface InvoiceReminderSendResult {
  contractorId: string
  name: string
  status: InvoiceReminderSendStatus
  message: string | null
}

// ─── 経費アップロード（モバイルICOCA・特急券など）─────────────────────────────
// 明細1行の用途。金額の行き先が区分ごとに違う（client_billed だけが client_expenses に入る）。
// 選択肢そのものは lib/config に置き、型はそこから導く。値と型を別々に書くと、
// 選択肢を足したときに型だけ古いままになって「選べるのに型エラー」が起きるため。
export type ExpenseItemKind = (typeof EXPENSE_ITEM_KINDS)[number]

// AI読み取り（lib/expense-extract）が返す明細1行。列名（expense_upload_items）と1対1に対応させ、
// AIに返させるJSONのキー・DBに入る形・画面で扱う形を揃える。
// amount だけ必須なのは、金額が読めない行は経費として意味を成さないため（読めなければ0で人が直す）。
export interface ExpenseExtractedItem {
  item_date: string | null //   YYYY-MM-DD。年を補えなかった行は null
  from_place: string | null //  利用区間の起点（領収書など区間の無い書類では null）
  to_place: string | null //    利用区間の終点
  description: string | null // 内容（「鉄道利用」「特急券」など）
  amount: number //             正の整数（原本のマイナス表記は絶対値に直す）
}

// 読み取りは失敗しても例外にせず、理由を持ち回って expense_uploads.extract_error に保存する
// （請求書の InvoiceExtractOutcome と同じ流儀）。
export type ExpenseExtractOutcome = { items: ExpenseExtractedItem[] } | { error: string }

// 一覧・受付APIが返す明細1行。client_id だけでは画面でクライアント名を出せないため名前を添える。
export type ExpenseUploadItemRow = ExpenseUploadItem & { client_name: string | null }

// 一覧・受付APIが返す受付1件。原本（file_data）は1件で数MBになりうるので列ごと外し、
// 必要なときだけ /api/expense-uploads/[id]/file から取り出す。
export type ExpenseUploadRow = Omit<ExpenseUpload, 'file_data'> & { items: ExpenseUploadItemRow[] }

// 代表が送信するときの明細1行分の割り当て。検証の正本は lib/validation の expenseSubmitSchema で、
// これは画面側が同じ形を組み立てるための型。
export interface ExpenseItemAssignment {
  id: string
  kind: ExpenseItemKind
  client_id: string | null
}

// 受付API（POST /api/expense-inbox）の応答。読み取った明細をそのまま返すのは、
// 代表が同じ画面で続けて割り当てられるようにするため（IDが無いと送信できない）。
// 読み取りに失敗しても受付自体は成功扱いなので、理由は extract_error に入って返る。
export interface ExpenseInboxResponse {
  id: string
  file_name: string
  file_type: string
  extract_error: string | null
  items: ExpenseUploadItem[]
}

// 登録API（POST /api/expense-uploads/[id]/approve）の応答。
// ドライブ保存に失敗しても登録自体は成立させるため、結果は成否ではなく drive に添えて返す
//（画面は「登録は済んだが控えだけ残せなかった」を出し分けられる）。
export interface ExpenseApproveResult {
  id: string
  status: 'registered'
  registered: number
  drive: { link: string; folderName: string } | { error: string } | { disabled: true }
}

// ─── 役員報酬・給与 ─────────────────────────────
// 支給区分。列の型から導き、選択肢（lib/config の PAYROLL_KINDS）と1対1に保つ。
export type PayrollKind = PayrollRecipient['kind']

// 手取りの計算に必要な6つの金額だけを抜き出した形（lib/payroll が受け取る）。
// マスタ（payroll_recipients）と月次の控え（monthly_payroll_records）は列名が違うだけで
// 計算はまったく同じため、どちらからもこの形に寄せて1つの計算式を共用する。
export interface PayrollAmounts {
  gross: number
  health_insurance: number
  pension: number
  employment_insurance: number
  income_tax: number
  resident_tax: number
}

// ダッシュボードが使う「月次の支給レコード + 対象者マスタ」の型。
// 種別ラベルと支払日はマスタ側にしか無いため（月次には控えていない）、結合して渡す。
export type PayrollRecordWithRecipient = MonthlyPayrollRecord & {
  payroll_recipients: Pick<PayrollRecipient, 'id' | 'name' | 'kind' | 'pay_day'> | null
}

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
