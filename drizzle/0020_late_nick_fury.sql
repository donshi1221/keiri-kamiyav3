CREATE TABLE "expense_upload_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"item_date" date,
	"from_place" text,
	"to_place" text,
	"description" text,
	"amount" integer DEFAULT 0 NOT NULL,
	"client_id" uuid,
	"category" text,
	"kind" text,
	"registered_client_expense_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text NOT NULL,
	"file_data" text NOT NULL,
	"file_type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"extract_error" text,
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_upload_items" ADD CONSTRAINT "expense_upload_items_upload_id_expense_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."expense_uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_upload_items" ADD CONSTRAINT "expense_upload_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;