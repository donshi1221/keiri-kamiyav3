import { pgTable, pgEnum, uuid, text, integer, boolean, timestamp, date, jsonb, unique } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import type { PAYROLL_KINDS } from './config'

// ─── Enums ────────────────────────────────────────────────────────────────────

export const contractorTypeEnum = pgEnum('contractor_type_enum', ['daiko', 'video_editor'])
export const sourceTypeEnum = pgEnum('source_type_enum', ['manual', 'file'])
export const chatRoleEnum = pgEnum('chat_role_enum', ['user', 'assistant'])
// 受け付けた請求書の確認状態。今は受付(pending)しか使わないが、
// 後続フェーズの突き合わせ結果（ok / ng / 保留）まで含めて先に定義しておく。
export const invoiceCheckStatusEnum = pgEnum('invoice_check_status_enum', ['pending', 'ok', 'ng', 'hold'])

// ─── Tables ───────────────────────────────────────────────────────────────────

export const contractors = pgTable('contractors', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  contractor_type: contractorTypeEnum('contractor_type').notNull().default('daiko'),
  // 動画1本あたりの単価（円）。編集者ごとに一律のためマスタ本体に持つ。
  // フル納品時の支払額は保存せず「unit_price × clients.monthly_video_count」で表示時に計算する。
  unit_price: integer('unit_price').notNull().default(0),
  email: text('email'),
  // Chatworkの個別チャットのルームID（数字の文字列）。請求書未提出リマインドの送信先。
  // 数値ではなく text にしているのは、IDがAPIのURLにそのまま載る識別子で計算に使わないため
  // （桁あふれや先頭0の欠落といった数値化に伴う事故を避ける）。未登録の人には送らない。
  chatwork_room_id: text('chatwork_room_id'),
  notes: text('notes'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // 請求書の明細に書かれる呼び名（通称・略称・字違い）。カンマ区切りで複数持つ。
  // 明細は「めぐ姉様」「ファースト」のようにマスタの正式名と別の呼び方で書かれることが多く、
  // 正式名だけでは突き合わせようがないため、照合用の別名をクライアント側に持たせる。
  aliases: text('aliases'),
  // 請求書の明細に書かれる「N/M」（例「7/28」）の読み方。既定は支払回数（全M回中N回目）だが、
  // クライアントによっては台本作成日（7月28日）を書く運用がある。読み方を取り違えると
  // 支払回数の整合チェックが必ず外れるため、切り替えをクライアント単位で持つ。
  nm_as_date: boolean('nm_as_date').notNull().default(false),
  contact_person: text('contact_person'),
  // billing_amount / contract_start / contract_months は請求内訳（client_billing_items）へ移行済み。
  // 列は移行の履歴と後方互換のため残すが、金額・契約期間の正本は client_billing_items 側。
  billing_amount: integer('billing_amount').notNull().default(0),
  contract_start: date('contract_start', { mode: 'string' }),
  contract_months: integer('contract_months'),
  // 月あたりの動画本数。編集者のフル納品額（単価×本数）の計算に使う。
  monthly_video_count: integer('monthly_video_count').notNull().default(0),
  notes: text('notes'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

// 請求内訳（明細）。1クライアントに複数ぶら下がり、内訳ごとに金額と契約期間を個別に持つ。
// 例: 同じクライアントの「YouTube運用費（4月開始6ヶ月）」「Instagram運用費（6月開始12ヶ月）」を
// それぞれ別行として管理し、契約開始・期間がズレても各内訳が独立して有効/終了する。
export const clientBillingItems = pgTable('client_billing_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  client_id: uuid('client_id').notNull().references(() => clients.id),
  label: text('label').notNull().default(''),
  billing_amount: integer('billing_amount').notNull().default(0),
  contract_start: date('contract_start', { mode: 'string' }),
  contract_months: integer('contract_months'),
  active: boolean('active').notNull().default(true),
  sort_order: integer('sort_order').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const assignments = pgTable('assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractor_id: uuid('contractor_id').notNull().references(() => contractors.id),
  client_id: uuid('client_id').notNull().references(() => clients.id),
  role_name: text('role_name').notNull().default('撮影+台本'),
  contractor_payout_amount: integer('contractor_payout_amount').notNull().default(0),
  // 支払い対象となる契約の開始月。未設定は既存データとの互換性のため継続扱い。
  payment_start_month: date('payment_start_month', { mode: 'string' }),
  // 支払い回数。未設定は回数制限なし。
  payment_count: integer('payment_count'),
  spreadsheet_url: text('spreadsheet_url'),
  active: boolean('active').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const monthlyRecords = pgTable('monthly_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  assignment_id: uuid('assignment_id').notNull().references(() => assignments.id),
  actual_payout_amount: integer('actual_payout_amount'),
  payout_amount_snapshot: integer('payout_amount_snapshot'),
  // 編集者への支払対象となった本数。納品チェックの「反映」時に控える。
  // 「支払った本数」の累計は、支払い確認済み(contractor_paid_at)の月のこの値を合算して出す。
  delivered_video_count: integer('delivered_video_count'),
  invoice_received_at: timestamp('invoice_received_at', { withTimezone: true, mode: 'string' }),
  payment_reserved_at: timestamp('payment_reserved_at', { withTimezone: true, mode: 'string' }),
  contractor_paid_at: timestamp('contractor_paid_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (t) => [unique().on(t.year, t.month, t.assignment_id)])

export const monthlyClientRecords = pgTable('monthly_client_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  // client_id は請求内訳の親クライアント。グループ表示・集計のため非正規化して保持する。
  client_id: uuid('client_id').notNull().references(() => clients.id),
  // billing_item_id が「どの内訳の月次記録か」を表す正本。二重生成防止の一意制約もこの列で行う。
  billing_item_id: uuid('billing_item_id').notNull().references(() => clientBillingItems.id),
  billing_amount_snapshot: integer('billing_amount_snapshot'),
  // 内訳名の控え。後で内訳名を変更・削除しても過去月の表示が変わらないよう、生成時点の名称を保存する。
  label_snapshot: text('label_snapshot'),
  invoice_sent_at: timestamp('invoice_sent_at', { withTimezone: true, mode: 'string' }),
  payment_confirmed_at: timestamp('payment_confirmed_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (t) => [unique().on(t.year, t.month, t.billing_item_id)])

export const monthlyGlobalTasks = pgTable('monthly_global_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  expense_confirmed_at: timestamp('expense_confirmed_at', { withTimezone: true, mode: 'string' }),
  payment_report_confirmed_at: timestamp('payment_report_confirmed_at', { withTimezone: true, mode: 'string' }),
  withholding_confirmed_at: timestamp('withholding_confirmed_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (t) => [unique().on(t.year, t.month)])

export const monthlyCustomGlobalTasks = pgTable('monthly_custom_global_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  months: integer('months').array().notNull().default(sql`'{}'::integer[]`),
  // 表示用の日にち（1〜31）。期限判定には使わず、「◯日」の表示・メモとしてのみ用いる。任意。
  day: integer('day'),
  completed_months: integer('completed_months').array().notNull().default(sql`'{}'::integer[]`),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

// 単発タスク。特定の日付に1回だけ行うタスクを管理する（繰り返しの monthly_custom_global_tasks とは別物）。
// 完了は月ごとではなく単一の completed_at で持つ。未完了のうちは期日の月以降ずっとダッシュボードに出す。
export const oneTimeTasks = pgTable('one_time_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  due_date: date('due_date', { mode: 'string' }).notNull(),
  completed_at: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const taxAdviceEntries = pgTable('tax_advice_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  source_type: sourceTypeEnum('source_type').notNull().default('manual'),
  file_name: text('file_name'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const taxChatSessions = pgTable('tax_chat_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull().default('新しい会話'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const taxChatMessages = pgTable('tax_chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  session_id: uuid('session_id').notNull().references(() => taxChatSessions.id, { onDelete: 'cascade' }),
  role: chatRoleEnum('role').notNull(),
  content: text('content').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const moneyforwardTokens = pgTable('moneyforward_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  access_token: text('access_token').notNull(),
  refresh_token: text('refresh_token').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

// Googleドライブ保存用のOAuthトークン。サービスアカウントはストレージ容量を持てず
// マイドライブへ書き込めないため、ユーザー本人の名義・容量で保存する方式に切り替えた。
// 連携先アカウントはアプリ全体で1つのため moneyforward_tokens と同じく1行だけを使い回す。
export const googleDriveTokens = pgTable('google_drive_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  access_token: text('access_token').notNull(),
  refresh_token: text('refresh_token').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const moneyforwardExpenses = pgTable('moneyforward_expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  amount: integer('amount').notNull().default(0),
  synced_at: timestamp('synced_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (t) => [unique().on(t.year, t.month)])

// cron（自動処理）の死活監視用。cronが成功するたびに last_success_at を更新し、
// 一定期間更新が無ければ「止まっている」とみなしてアラートを出す。
export const cronRuns = pgTable('cron_runs', {
  name: text('name').primaryKey(),
  last_success_at: timestamp('last_success_at', { withTimezone: true, mode: 'string' }).notNull(),
})

// 立替経費（交通費など）。代行者に紐づけて登録し、同額をクライアントへ請求する（パススルー）。
// assignment_id が「どの委託者×どのクライアントか」を兼ねるため、委託者側で登録すればクライアントが定まる。
// year/month は「どの月の支払い・請求に乗せるか」。expense_date は記録用で月の判定には使わない
// （表示中の月と違う日付を入れても、その月の集計から外れないようにするため）。
export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  assignment_id: uuid('assignment_id').notNull().references(() => assignments.id),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  expense_date: date('expense_date', { mode: 'string' }),
  amount: integer('amount').notNull().default(0),
  note: text('note'),
  // 請求書送付チェック。内訳（monthly_client_records）の送付とは別に、経費分の請求漏れを追えるようにする。
  invoice_sent_at: timestamp('invoice_sent_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

// 自社が直接払った経費（素材購入費・広告費など）。委託者を経由せず自社が支払い、クライアントには請求する。
// expenses（立替経費）と表を分けているのは、expenses が「委託者に払う」意味を必ず持つため。
// 払わない経費を同じ表に混ぜると、委託者への支払い集計に紛れ込んで過払いを生む危険がある。
// client_id に直接ぶら下げるのは、委託者が介在しない＝assignment（委託者×クライアント）で特定できないため。
// year/month は「どの月の請求に乗せるか」。expense_date は記録用で月の判定には使わない（expenses と同じ扱い）。
export const clientExpenses = pgTable('client_expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  client_id: uuid('client_id').notNull().references(() => clients.id),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  expense_date: date('expense_date', { mode: 'string' }),
  amount: integer('amount').notNull().default(0),
  note: text('note'),
  // 請求書送付チェック（expenses と同じ扱い）。
  invoice_sent_at: timestamp('invoice_sent_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

// アプリ全体で1つだけ持つ設定値のkey-valueストア。現在の用途は請求書受付URLのトークン。
// 環境変数ではなくDBに置くのは、画面から再発行（値の書き換え）ができる必要があるため。
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

// 外部（編集者・代行者）から公開URL経由で届いた請求書PDFの受け皿。
// contractor_id は後続フェーズでAIが差出人を推定して埋めるため、受付時点では未確定（null）。
// file_data はPDFのbase64。後続フェーズのAI読み取りで原本が必要になるため、抽出テキストではなく原本を残す。
export const invoiceUploads = pgTable('invoice_uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractor_id: uuid('contractor_id').references(() => contractors.id),
  file_name: text('file_name').notNull(),
  file_data: text('file_data').notNull(),
  status: invoiceCheckStatusEnum('status').notNull().default('pending'),
  // AI読み取りの結果。読めなかった項目は個別に null になる（1項目でも読めれば残りは活かす）。
  extracted_amount: integer('extracted_amount'), //     請求合計額（税込・控除後の最終請求額、円）
  extracted_issuer: text('extracted_issuer'), //        差出人（請求書の発行者名）
  extracted_addressee: text('extracted_addressee'), //  宛名
  // 「◯年◯月分」の対象月。年の記載がない請求書では月だけ埋まり、年は null のままになる。
  extracted_year: integer('extracted_year'),
  extracted_month: integer('extracted_month'),
  // 明細行（クライアント別・案件別の内訳）。合計だけを見ると「Aで1本多く、Bで1本少ない」のような
  // 相殺が見逃されるため、行ごとの名称・本数・金額をそのまま残して内訳単位でも照合する。
  // 読み取れなかった項目は行の中で null にする（行ごと落とすと請求書の見た目と対応が取れなくなる）。
  // 内訳の無い請求書もあるので、空配列と null（＝まだ読み取っていない）は別物として扱う。
  // kind は明細の種別。業務の対価（work）はクライアント別の支払予定と、実費・立替（expense）は
  // 登録済みの立替経費と突き合わせる＝照合相手が別物なので、読み取り時に分けておく。
  // kind を追加する前に保存された行には入っていないため任意にし、照合側で work とみなす。
  // client はその明細がどのクライアント分かをAIが請求書全体（摘要・備考など）から判断した名称。
  // 明細が動画タイトルで書かれ、クライアント名は摘要欄にしか無い請求書があり、ラベルの文字列照合だけでは
  // 帰属を決められないため、読み取りの時点で別項目として残す。client を追加する前に保存された行には
  // 入っていないため任意にし、照合側はラベル照合へ自動的に戻る。
  // 型は lib/ui-types の InvoiceExtractedItem として派生させて使う。
  extracted_items: jsonb('extracted_items').$type<
    {
      label: string
      count: number | null
      amount: number | null
      kind?: 'work' | 'expense'
      client?: string | null
    }[]
  >(),
  // 読み取り失敗の理由（人間向け）。成功時は null に戻す＝再読み取りの成否がそのまま残る。
  extract_error: text('extract_error'),
  extracted_at: timestamp('extracted_at', { withTimezone: true, mode: 'string' }),
  // 自動照合の結果。extracted_* が「請求書に何と書いてあったか」なのに対し、
  // resolved_* は「システムがどの月として扱ったか」＝判定の根拠。年の記載が無い請求書でも
  // 年を補ってから照合するため、両方を残さないと後から判定を検証できない。
  resolved_year: integer('resolved_year'),
  resolved_month: integer('resolved_month'),
  // 照合時点の支払予定額。マスタや月次レコードは後から変わるため、
  // 「いつの時点の予定額と比べたのか」を残しておかないと判定を再現できない。
  expected_amount: integer('expected_amount'),
  // 判定理由（人間向け・改行区切りで全観点分）。OK/NGの結論だけでは根拠が追えないため必ず残す。
  check_notes: text('check_notes'),
  // 人が目視で確認を済ませた「注意」行のキー一覧（lib/invoice-match の cautionKeyOf が作る文字列）。
  // check_notes は再チェックのたびに丸ごと作り直されるため、確認済みの事実を注意行そのものには残せない。
  // 別列に持たせることで、マスタ修正・再読み取りを挟んでも「人が見た」ことが消えないようにする。
  confirmed_cautions: jsonb('confirmed_cautions').$type<string[]>(),
  checked_at: timestamp('checked_at', { withTimezone: true, mode: 'string' }),
  // 照合OK後にGoogleドライブへ保存した控え。drive_file_id が入っていること自体が
  // 「保存済み」の印になり、再チェック時に二重アップロードするか再試行するかの判断に使う。
  drive_file_id: text('drive_file_id'),
  drive_link: text('drive_link'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

// 代表から届く経費ファイル（モバイルICOCAの利用履歴PDF・特急券の領収書画像）の受け皿。
// 1ファイルに1か月分・10件前後の明細が入っているため、ファイル本体（この表）と
// 明細1行（expense_upload_items）を分けて持つ。行ごとに帰属先クライアントと科目が変わるため。
// file_type を残すのはPDFと画像の両方を受けるから。原本を返すときのContent-Typeに使う。
export const expenseUploads = pgTable('expense_uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  file_name: text('file_name').notNull(),
  file_data: text('file_data').notNull(),
  file_type: text('file_type').notNull(),
  // 受付から登録までの進み具合。
  //   draft     … 読み取り済み・代表が割当中
  //   submitted … 代表が送信済み（経理の確認待ち）
  //   registered / rejected … 経理が登録 / 却下
  // enum ではなく text にしているのは、運用に合わせて区分を足すときにDBの型変更を伴わせないため。
  status: text('status').notNull().default('draft'),
  // AI読み取りに失敗した理由（人間向け）。読み取れなくてもファイルは預かる方針のため、
  // 「受付は成功・読み取りだけ失敗」を区別できるようにここへ残す。
  extract_error: text('extract_error'),
  submitted_at: timestamp('submitted_at', { withTimezone: true, mode: 'string' }),
  reviewed_at: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

// 経費ファイルの明細1行（ICOCAなら「07/30 神高阪急三宮→神鉄長田 鉄道利用 350円」の1行）。
// 読み取れなかった項目は null にして人が直せるようにする（行ごと落とすと原本と対応が取れなくなる）。
export const expenseUploadItems = pgTable('expense_upload_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  upload_id: uuid('upload_id').notNull().references(() => expenseUploads.id),
  // 利用日。原本には年が無い（「07/30」）ため、対象年月やファイル名から補う。補えなければ null。
  item_date: date('item_date', { mode: 'string' }),
  from_place: text('from_place'),
  to_place: text('to_place'),
  description: text('description'),
  // 原本はマイナス表記（-350 円）だが、経費としては正の数で扱うため読み取り時に絶対値へ直す。
  amount: integer('amount').notNull().default(0),
  // 代表が割り当てる帰属先。読み取り直後は未割当（null）。
  client_id: uuid('client_id').references(() => clients.id),
  // 経費科目。現在は使っていない（代表に選ばせるのをやめたため常に null が入る）。
  // 列を消すには別のマイグレーションが要るうえ、残しても実害が無く、科目を復活させたくなったときに
  // そのまま使えるため、適用済みの 0020 のまま据え置く。
  category: text('category'),
  // 明細の用途（lib/config の EXPENSE_ITEM_KINDS）。金額の行き先が区分ごとに違う。
  kind: text('kind'),
  // 登録時に作った client_expenses の行のID。入っていること自体が「登録済み」の印になり、
  // 二重登録の検出と、後から「この経費はどのファイルの何行目から来たか」を辿る手がかりになる。
  // 外部キーにしていないのは、経費側の行を消したいときに控えが削除を邪魔しないようにするため。
  registered_client_expense_id: uuid('registered_client_expense_id'),
  // 原本（PDF）の並び順。日付が読めない行もあるため、日付でなく元の順序で並べられるようにする。
  sort_order: integer('sort_order').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

// 役員報酬・給与の支給対象者（役員1名＋従業員1名）。
// 保険料率表・源泉徴収税額表はアプリに持たず、控除額はここに登録された値をそのまま使う
// （料率は毎年変わるうえ、等級の判定まで抱えると保守しきれないため。改定時は人がこの値を直す）。
// kind を enum ではなく text にしているのは、区分を足すときにDBの型変更を伴わせないため
// （expense_upload_items.kind と同じ流儀）。取りうる値は lib/config の PAYROLL_KINDS。
export const payrollRecipients = pgTable('payroll_recipients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: text('kind').$type<(typeof PAYROLL_KINDS)[number]>().notNull().default('employee'),
  // 額面（円）。ここから下の5つの控除を引いた残りが振込額（手取り）になる。
  gross_amount: integer('gross_amount').notNull().default(0),
  // 本人負担分の控除額（円）。会社負担分はここには入れない（振込額の計算に関係しないため）。
  health_insurance: integer('health_insurance').notNull().default(0),
  pension: integer('pension').notNull().default(0),
  employment_insurance: integer('employment_insurance').notNull().default(0),
  income_tax: integer('income_tax').notNull().default(0),
  resident_tax: integer('resident_tax').notNull().default(0),
  // 支払日（1〜31）。表示と振込リマインドの期日に使う。未設定は lib/config の既定日で扱う。
  pay_day: integer('pay_day'),
  active: boolean('active').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

// 月次の支給レコード。マスタを改定しても過去月の表示・振込額が変わらないよう、
// 生成時点の額面と5つの控除額をすべて控える（snapshot）。
// 料率改定の月はこの控えを直接直す（マスタを直すと過去月まで遡って変わってしまうため）。
// 控えを notNull にしているのは、生成時に必ず全項目を書き込むため。
// 手取りは6項目の引き算で毎回出すので、nullを許すと計算のたびに null 判定が要る。
export const monthlyPayrollRecords = pgTable('monthly_payroll_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  recipient_id: uuid('recipient_id').notNull().references(() => payrollRecipients.id),
  gross_snapshot: integer('gross_snapshot').notNull().default(0),
  health_insurance_snapshot: integer('health_insurance_snapshot').notNull().default(0),
  pension_snapshot: integer('pension_snapshot').notNull().default(0),
  employment_insurance_snapshot: integer('employment_insurance_snapshot').notNull().default(0),
  income_tax_snapshot: integer('income_tax_snapshot').notNull().default(0),
  resident_tax_snapshot: integer('resident_tax_snapshot').notNull().default(0),
  paid_at: timestamp('paid_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (t) => [unique().on(t.year, t.month, t.recipient_id)])

// ─── Relations ────────────────────────────────────────────────────────────────

export const contractorsRelations = relations(contractors, ({ many }) => ({
  assignments: many(assignments),
}))

export const clientsRelations = relations(clients, ({ many }) => ({
  assignments: many(assignments),
  monthly_client_records: many(monthlyClientRecords),
  billing_items: many(clientBillingItems),
  client_expenses: many(clientExpenses),
  expense_upload_items: many(expenseUploadItems),
}))

export const clientBillingItemsRelations = relations(clientBillingItems, ({ one, many }) => ({
  clients: one(clients, {
    fields: [clientBillingItems.client_id],
    references: [clients.id],
  }),
  monthly_client_records: many(monthlyClientRecords),
}))

export const assignmentsRelations = relations(assignments, ({ one, many }) => ({
  contractors: one(contractors, {
    fields: [assignments.contractor_id],
    references: [contractors.id],
  }),
  clients: one(clients, {
    fields: [assignments.client_id],
    references: [clients.id],
  }),
  monthly_records: many(monthlyRecords),
  expenses: many(expenses),
}))

export const expensesRelations = relations(expenses, ({ one }) => ({
  assignments: one(assignments, {
    fields: [expenses.assignment_id],
    references: [assignments.id],
  }),
}))

export const clientExpensesRelations = relations(clientExpenses, ({ one }) => ({
  clients: one(clients, {
    fields: [clientExpenses.client_id],
    references: [clients.id],
  }),
}))

export const monthlyRecordsRelations = relations(monthlyRecords, ({ one }) => ({
  assignments: one(assignments, {
    fields: [monthlyRecords.assignment_id],
    references: [assignments.id],
  }),
}))

export const monthlyClientRecordsRelations = relations(monthlyClientRecords, ({ one }) => ({
  clients: one(clients, {
    fields: [monthlyClientRecords.client_id],
    references: [clients.id],
  }),
  billing_items: one(clientBillingItems, {
    fields: [monthlyClientRecords.billing_item_id],
    references: [clientBillingItems.id],
  }),
}))

export const expenseUploadsRelations = relations(expenseUploads, ({ many }) => ({
  items: many(expenseUploadItems),
}))

export const expenseUploadItemsRelations = relations(expenseUploadItems, ({ one }) => ({
  expense_uploads: one(expenseUploads, {
    fields: [expenseUploadItems.upload_id],
    references: [expenseUploads.id],
  }),
  clients: one(clients, {
    fields: [expenseUploadItems.client_id],
    references: [clients.id],
  }),
}))

export const payrollRecipientsRelations = relations(payrollRecipients, ({ many }) => ({
  monthly_payroll_records: many(monthlyPayrollRecords),
}))

export const monthlyPayrollRecordsRelations = relations(monthlyPayrollRecords, ({ one }) => ({
  payroll_recipients: one(payrollRecipients, {
    fields: [monthlyPayrollRecords.recipient_id],
    references: [payrollRecipients.id],
  }),
}))

export const taxChatSessionsRelations = relations(taxChatSessions, ({ many }) => ({
  messages: many(taxChatMessages),
}))

export const taxChatMessagesRelations = relations(taxChatMessages, ({ one }) => ({
  session: one(taxChatSessions, {
    fields: [taxChatMessages.session_id],
    references: [taxChatSessions.id],
  }),
}))

// ─── Types ────────────────────────────────────────────────────────────────────

export type Contractor = typeof contractors.$inferSelect
export type Client = typeof clients.$inferSelect
export type ClientBillingItem = typeof clientBillingItems.$inferSelect
export type Assignment = typeof assignments.$inferSelect
export type MonthlyRecord = typeof monthlyRecords.$inferSelect
export type MonthlyClientRecord = typeof monthlyClientRecords.$inferSelect
export type MonthlyGlobalTask = typeof monthlyGlobalTasks.$inferSelect
export type CustomGlobalTask = typeof monthlyCustomGlobalTasks.$inferSelect
export type OneTimeTask = typeof oneTimeTasks.$inferSelect
export type TaxAdviceEntry = typeof taxAdviceEntries.$inferSelect
export type TaxChatSession = typeof taxChatSessions.$inferSelect
export type TaxChatMessage = typeof taxChatMessages.$inferSelect
export type CronRun = typeof cronRuns.$inferSelect
export type Expense = typeof expenses.$inferSelect
export type ClientExpense = typeof clientExpenses.$inferSelect
export type AppSetting = typeof appSettings.$inferSelect
export type InvoiceUpload = typeof invoiceUploads.$inferSelect
export type ExpenseUpload = typeof expenseUploads.$inferSelect
export type ExpenseUploadItem = typeof expenseUploadItems.$inferSelect
export type GoogleDriveToken = typeof googleDriveTokens.$inferSelect
export type PayrollRecipient = typeof payrollRecipients.$inferSelect
export type MonthlyPayrollRecord = typeof monthlyPayrollRecords.$inferSelect
