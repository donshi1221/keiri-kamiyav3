import { pgTable, pgEnum, uuid, text, integer, boolean, timestamp, date, unique } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'

// ─── Enums ────────────────────────────────────────────────────────────────────

export const contractorTypeEnum = pgEnum('contractor_type_enum', ['daiko', 'video_editor'])
export const sourceTypeEnum = pgEnum('source_type_enum', ['manual', 'file'])
export const chatRoleEnum = pgEnum('chat_role_enum', ['user', 'assistant'])

// ─── Tables ───────────────────────────────────────────────────────────────────

export const contractors = pgTable('contractors', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  contractor_type: contractorTypeEnum('contractor_type').notNull().default('daiko'),
  // 動画1本あたりの単価（円）。編集者ごとに一律のためマスタ本体に持つ。
  // フル納品時の支払額は保存せず「unit_price × clients.monthly_video_count」で表示時に計算する。
  unit_price: integer('unit_price').notNull().default(0),
  email: text('email'),
  notes: text('notes'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
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

// ─── Relations ────────────────────────────────────────────────────────────────

export const contractorsRelations = relations(contractors, ({ many }) => ({
  assignments: many(assignments),
}))

export const clientsRelations = relations(clients, ({ many }) => ({
  assignments: many(assignments),
  monthly_client_records: many(monthlyClientRecords),
  billing_items: many(clientBillingItems),
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
