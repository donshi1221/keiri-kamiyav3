ALTER TABLE "invoice_uploads" ADD COLUMN "resolved_year" integer;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "resolved_month" integer;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "expected_amount" integer;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "check_notes" text;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "checked_at" timestamp with time zone;