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
  email: text('email'),
  notes: text('notes'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  contact_person: text('contact_person'),
  billing_amount: integer('billing_amount').notNull().default(0),
  contract_start: date('contract_start', { mode: 'string' }),
  contract_months: integer('contract_months'),
  notes: text('notes'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
})

export const assignments = pgTable('assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractor_id: uuid('contractor_id').notNull().references(() => contractors.id),
  client_id: uuid('client_id').notNull().references(() => clients.id),
  role_name: text('role_name').notNull().default('撮影+台本'),
  contractor_payout_amount: integer('contractor_payout_amount').notNull().default(0),
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
  invoice_received_at: timestamp('invoice_received_at', { withTimezone: true, mode: 'string' }),
  contractor_paid_at: timestamp('contractor_paid_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (t) => [unique().on(t.year, t.month, t.assignment_id)])

export const monthlyClientRecords = pgTable('monthly_client_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  client_id: uuid('client_id').notNull().references(() => clients.id),
  invoice_sent_at: timestamp('invoice_sent_at', { withTimezone: true, mode: 'string' }),
  payment_confirmed_at: timestamp('payment_confirmed_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (t) => [unique().on(t.year, t.month, t.client_id)])

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
  completed_months: integer('completed_months').array().notNull().default(sql`'{}'::integer[]`),
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

// ─── Relations ────────────────────────────────────────────────────────────────

export const contractorsRelations = relations(contractors, ({ many }) => ({
  assignments: many(assignments),
}))

export const clientsRelations = relations(clients, ({ many }) => ({
  assignments: many(assignments),
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
export type Assignment = typeof assignments.$inferSelect
export type MonthlyRecord = typeof monthlyRecords.$inferSelect
export type MonthlyClientRecord = typeof monthlyClientRecords.$inferSelect
export type MonthlyGlobalTask = typeof monthlyGlobalTasks.$inferSelect
export type CustomGlobalTask = typeof monthlyCustomGlobalTasks.$inferSelect
export type TaxAdviceEntry = typeof taxAdviceEntries.$inferSelect
export type TaxChatSession = typeof taxChatSessions.$inferSelect
export type TaxChatMessage = typeof taxChatMessages.$inferSelect
