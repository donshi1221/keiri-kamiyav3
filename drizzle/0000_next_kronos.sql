CREATE TYPE "public"."chat_role_enum" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."contractor_type_enum" AS ENUM('daiko', 'video_editor');--> statement-breakpoint
CREATE TYPE "public"."source_type_enum" AS ENUM('manual', 'file');--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"role_name" text DEFAULT '撮影+台本' NOT NULL,
	"contractor_payout_amount" integer DEFAULT 0 NOT NULL,
	"spreadsheet_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_person" text,
	"billing_amount" integer DEFAULT 0 NOT NULL,
	"contract_start" date,
	"contract_months" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contractor_type" "contractor_type_enum" DEFAULT 'daiko' NOT NULL,
	"email" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moneyforward_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moneyforward_expenses_year_month_unique" UNIQUE("year","month")
);
--> statement-breakpoint
CREATE TABLE "moneyforward_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monthly_client_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"client_id" uuid NOT NULL,
	"billing_amount_snapshot" integer,
	"invoice_sent_at" timestamp with time zone,
	"payment_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_client_records_year_month_client_id_unique" UNIQUE("year","month","client_id")
);
--> statement-breakpoint
CREATE TABLE "monthly_custom_global_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"months" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"completed_months" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monthly_global_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"expense_confirmed_at" timestamp with time zone,
	"payment_report_confirmed_at" timestamp with time zone,
	"withholding_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_global_tasks_year_month_unique" UNIQUE("year","month")
);
--> statement-breakpoint
CREATE TABLE "monthly_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"assignment_id" uuid NOT NULL,
	"actual_payout_amount" integer,
	"payout_amount_snapshot" integer,
	"invoice_received_at" timestamp with time zone,
	"payment_reserved_at" timestamp with time zone,
	"contractor_paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_records_year_month_assignment_id_unique" UNIQUE("year","month","assignment_id")
);
--> statement-breakpoint
CREATE TABLE "tax_advice_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"source_type" "source_type_enum" DEFAULT 'manual' NOT NULL,
	"file_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "chat_role_enum" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT '新しい会話' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_client_records" ADD CONSTRAINT "monthly_client_records_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_records" ADD CONSTRAINT "monthly_records_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_chat_messages" ADD CONSTRAINT "tax_chat_messages_session_id_tax_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."tax_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;