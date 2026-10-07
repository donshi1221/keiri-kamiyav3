CREATE TABLE "invoice_check_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" "invoice_check_status_enum" NOT NULL,
	"check_notes" text,
	"extracted_amount" integer,
	"expected_amount" integer,
	"ng_reasons" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"draft_body" text NOT NULL,
	"sent_body" text,
	"state" text DEFAULT 'draft' NOT NULL,
	"chatwork_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_replies_upload_id_unique" UNIQUE("upload_id")
);
--> statement-breakpoint
ALTER TABLE "invoice_uploads" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_check_history" ADD CONSTRAINT "invoice_check_history_upload_id_invoice_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."invoice_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_replies" ADD CONSTRAINT "invoice_replies_upload_id_invoice_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."invoice_uploads"("id") ON DELETE cascade ON UPDATE no action;