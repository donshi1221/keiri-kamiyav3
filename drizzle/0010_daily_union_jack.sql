ALTER TABLE "invoice_uploads" ADD COLUMN "extracted_amount" integer;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "extracted_issuer" text;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "extracted_addressee" text;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "extracted_year" integer;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "extracted_month" integer;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "extract_error" text;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "extracted_at" timestamp with time zone;