ALTER TABLE "expenses" ADD COLUMN "category" text DEFAULT 'expense' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "bill_client" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "invoice_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "invoice_item_key" text;--> statement-breakpoint
ALTER TABLE "invoice_check_history" ADD COLUMN "extra_items" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "rejected_extras" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "extra_items" jsonb;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_invoice_upload_id_invoice_uploads_id_fk" FOREIGN KEY ("invoice_upload_id") REFERENCES "public"."invoice_uploads"("id") ON DELETE set null ON UPDATE no action;