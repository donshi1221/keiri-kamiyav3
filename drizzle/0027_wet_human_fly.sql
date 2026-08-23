CREATE TABLE "payroll_recurring_reimbursements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount" integer NOT NULL,
	"start_year" integer NOT NULL,
	"start_month" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_reimbursement_items" ADD COLUMN "recurring_id" uuid;--> statement-breakpoint
ALTER TABLE "payroll_recurring_reimbursements" ADD CONSTRAINT "payroll_recurring_reimbursements_recipient_id_payroll_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."payroll_recipients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_reimbursement_items" ADD CONSTRAINT "payroll_reimbursement_items_recurring_id_year_month_unique" UNIQUE("recurring_id","year","month");