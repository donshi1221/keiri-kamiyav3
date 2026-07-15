-- 1. 請求内訳テーブルを作成
CREATE TABLE "client_billing_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"billing_amount" integer DEFAULT 0 NOT NULL,
	"contract_start" date,
	"contract_months" integer,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_billing_items" ADD CONSTRAINT "client_billing_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 2. 既存クライアントごとに内訳を1件生成し、現在の金額・契約期間をそのままコピーする（移行後も表示は不変）
INSERT INTO "client_billing_items" ("client_id", "label", "billing_amount", "contract_start", "contract_months", "active", "sort_order")
SELECT "id", '', "billing_amount", "contract_start", "contract_months", true, 0 FROM "clients";--> statement-breakpoint
-- 3. 旧一意制約（年・月・クライアント）を外す
ALTER TABLE "monthly_client_records" DROP CONSTRAINT "monthly_client_records_year_month_client_id_unique";--> statement-breakpoint
-- 4. 新しい列を「まず nullable」で追加（既存行があるため NOT NULL では追加できない）
ALTER TABLE "monthly_client_records" ADD COLUMN "billing_item_id" uuid;--> statement-breakpoint
ALTER TABLE "monthly_client_records" ADD COLUMN "label_snapshot" text;--> statement-breakpoint
-- 5. 既存の月次記録を、同じクライアントの内訳（各クライアント1件）へ紐付ける
UPDATE "monthly_client_records" AS "mcr"
SET "billing_item_id" = "cbi"."id"
FROM "client_billing_items" AS "cbi"
WHERE "cbi"."client_id" = "mcr"."client_id";--> statement-breakpoint
-- 6. 全行の紐付けが済んだので NOT NULL 化
ALTER TABLE "monthly_client_records" ALTER COLUMN "billing_item_id" SET NOT NULL;--> statement-breakpoint
-- 7. 外部キーと新しい一意制約（年・月・内訳）を付与
ALTER TABLE "monthly_client_records" ADD CONSTRAINT "monthly_client_records_billing_item_id_client_billing_items_id_fk" FOREIGN KEY ("billing_item_id") REFERENCES "public"."client_billing_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_client_records" ADD CONSTRAINT "monthly_client_records_year_month_billing_item_id_unique" UNIQUE("year","month","billing_item_id");
