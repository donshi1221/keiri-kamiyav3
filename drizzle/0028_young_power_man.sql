-- 1. 内訳ごとの月本数の列を追加
ALTER TABLE "client_billing_items" ADD COLUMN "monthly_video_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 2. 既存クライアントの月本数を、そのクライアントの先頭の内訳へそのまま移す。
-- 合計が変わらないので、移行後も「フル納品」の表示は変化しない（複数内訳の場合は画面から振り分け直す）。
UPDATE "client_billing_items" AS "bi"
SET "monthly_video_count" = "c"."monthly_video_count"
FROM "clients" AS "c"
WHERE "c"."id" = "bi"."client_id"
  AND "c"."monthly_video_count" > 0
  AND "bi"."id" = (
    SELECT "x"."id" FROM "client_billing_items" AS "x"
    WHERE "x"."client_id" = "c"."id"
    ORDER BY "x"."sort_order" ASC, "x"."created_at" ASC
    LIMIT 1
  );
