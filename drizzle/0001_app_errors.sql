CREATE TABLE "app_errors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"digest" text,
	"path" text,
	"method" text,
	"source" text,
	"user_id" uuid,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_errors" ADD CONSTRAINT "app_errors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_errors_created_idx" ON "app_errors" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "app_errors_ip_idx" ON "app_errors" USING btree ("ip","created_at");