CREATE TABLE "monthly_payroll_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"recipient_id" uuid NOT NULL,
	"gross_snapshot" integer DEFAULT 0 NOT NULL,
	"health_insurance_snapshot" integer DEFAULT 0 NOT NULL,
	"pension_snapshot" integer DEFAULT 0 NOT NULL,
	"employment_insurance_snapshot" integer DEFAULT 0 NOT NULL,
	"income_tax_snapshot" integer DEFAULT 0 NOT NULL,
	"resident_tax_snapshot" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_payroll_records_year_month_recipient_id_unique" UNIQUE("year","month","recipient_id")
);
--> statement-breakpoint
CREATE TABLE "payroll_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'employee' NOT NULL,
	"gross_amount" integer DEFAULT 0 NOT NULL,
	"health_insurance" integer DEFAULT 0 NOT NULL,
	"pension" integer DEFAULT 0 NOT NULL,
	"employment_insurance" integer DEFAULT 0 NOT NULL,
	"income_tax" integer DEFAULT 0 NOT NULL,
	"resident_tax" integer DEFAULT 0 NOT NULL,
	"pay_day" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monthly_payroll_records" ADD CONSTRAINT "monthly_payroll_records_recipient_id_payroll_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."payroll_recipients"("id") ON DELETE no action ON UPDATE no action;