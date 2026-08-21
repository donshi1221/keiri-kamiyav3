CREATE TABLE "payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text NOT NULL,
	"file_data" text NOT NULL,
	"file_type" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"extracted_payee" text,
	"extracted_amount" integer,
	"extracted_due_date" date,
	"extract_error" text,
	"extracted_at" timestamp with time zone,
	"reserved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"drive_file_id" text,
	"drive_link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
