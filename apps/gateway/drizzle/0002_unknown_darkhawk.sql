ALTER TABLE "points_ledger" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_idempotency_key_unique" UNIQUE("idempotency_key");