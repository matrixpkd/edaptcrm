CREATE TABLE "rate_limit_hits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_temporary_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "rate_limit_hits_subject_idx" ON "rate_limit_hits" USING btree ("bucket","subject","created_at");--> statement-breakpoint
CREATE INDEX "rate_limit_hits_created_idx" ON "rate_limit_hits" USING btree ("created_at");