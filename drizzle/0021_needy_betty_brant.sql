ALTER TABLE "client_expenses" ADD COLUMN "invoice_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "invoice_sent_at" timestamp with time zone;