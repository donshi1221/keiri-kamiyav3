CREATE TABLE "cron_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_success_at" timestamp with time zone NOT NULL
);
