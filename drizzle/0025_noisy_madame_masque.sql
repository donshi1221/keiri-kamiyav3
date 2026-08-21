CREATE TABLE "payroll_reimbursement_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"item_date" date,
	"description" text NOT NULL,
	"amount" integer NOT NULL,
	"expense_upload_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_reimbursement_items_expense_upload_item_id_unique" UNIQUE("expense_upload_item_id")
);
--> statement-breakpoint
ALTER TABLE "payroll_reimbursement_items" ADD CONSTRAINT "payroll_reimbursement_items_recipient_id_payroll_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."payroll_recipients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "payroll_reimbursement_items" ("recipient_id", "year", "month", "item_date", "description", "amount") SELECT "recipient_id", "year", "month", NULL, '立替経費（明細化前の移行分）', "expense_reimbursement" FROM "monthly_payroll_records" WHERE "expense_reimbursement" > 0;--> statement-breakpoint
ALTER TABLE "monthly_payroll_records" DROP COLUMN "expense_reimbursement";