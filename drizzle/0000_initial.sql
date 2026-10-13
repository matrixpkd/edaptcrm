CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" text,
	"action" text DEFAULT 'update' NOT NULL,
	"field" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"winner_id" uuid NOT NULL,
	"loser_id" uuid NOT NULL,
	"moved" jsonb NOT NULL,
	"winner_before" jsonb NOT NULL,
	"reason" text,
	"merged_by_id" uuid,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"phone_country" text,
	"name" text NOT NULL,
	"email" text,
	"alt_phones" text[] DEFAULT '{}'::text[] NOT NULL,
	"alt_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"type" text DEFAULT 'individual' NOT NULL,
	"organisation_id" uuid,
	"city" text,
	"state" text,
	"country" text,
	"language" text,
	"age_band" text,
	"industry" text,
	"designation" text,
	"company_name" text,
	"spending_band" integer,
	"ai_level" integer,
	"umer_level" integer,
	"gut_stars" integer,
	"field_sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sales_notes" text,
	"first_door" text NOT NULL,
	"first_campaign" text,
	"first_channel" text,
	"last_channel" text,
	"last_campaign" text,
	"referred_by_id" uuid,
	"consent" boolean,
	"consent_at" timestamp with time zone,
	"stage" text DEFAULT 'new' NOT NULL,
	"lost_reason" text,
	"stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_id" uuid,
	"first_owner_id" uuid,
	"owner_assigned_at" timestamp with time zone,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by_id" uuid,
	"last_enquiry_at" timestamp with time zone,
	"last_interaction_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"ltv_inr" numeric(14, 2) DEFAULT 0 NOT NULL,
	"purchase_count" integer DEFAULT 0 NOT NULL,
	"family_count" integer DEFAULT 0 NOT NULL,
	"families" text[] DEFAULT '{}'::text[] NOT NULL,
	"current_rung" integer DEFAULT 0 NOT NULL,
	"first_purchase_at" timestamp with time zone,
	"last_purchase_at" timestamp with time zone,
	"first_family" text,
	"avg_gap_days" numeric(10, 2),
	"next_expected_at" timestamp with time zone,
	"at_risk" boolean DEFAULT false NOT NULL,
	"repeat_prob_90d" numeric(6, 4),
	"expected_90d_inr" numeric(14, 2),
	"next_offer" text,
	"next_offer_product_id" uuid,
	"fit" integer,
	"readiness" integer,
	"value" integer,
	"edapt_score" integer,
	"grade" text,
	"network_value_inr" numeric(14, 2) DEFAULT 0 NOT NULL,
	"referral_count" integer DEFAULT 0 NOT NULL,
	"scored_at" timestamp with time zone,
	"merged_into_id" uuid,
	"merged_at" timestamp with time zone,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duplicate_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_a_id" uuid NOT NULL,
	"contact_b_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"campaign" text,
	"product_interest" text,
	"source_ref" text,
	"raw_payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text NOT NULL,
	"source" text NOT NULL,
	"uploaded_by_id" uuid,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mapping" jsonb,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"undone_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"mapped" jsonb,
	"cleaned" jsonb,
	"match_result" text,
	"match_contact_id" uuid,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution" text,
	"contact_id" uuid,
	"applied" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"direction" text DEFAULT 'out' NOT NULL,
	"outcome" text,
	"summary" text,
	"next_follow_up_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"ip" text NOT NULL,
	"success" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"contact_id" uuid,
	"task_id" uuid,
	"email" boolean DEFAULT false NOT NULL,
	"emailed_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'company' NOT NULL,
	"city" text,
	"state" text,
	"country" text,
	"phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ownership_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"from_user_id" uuid,
	"to_user_id" uuid,
	"reason" text NOT NULL,
	"changed_by_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text DEFAULT 'payment' NOT NULL,
	"seq" integer DEFAULT 1 NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"fx_rate" numeric(14, 6) DEFAULT 1 NOT NULL,
	"amount_inr" numeric(14, 2) NOT NULL,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"mode" text,
	"reference" text,
	"status" text DEFAULT 'unverified' NOT NULL,
	"verified_by_id" uuid,
	"verified_at" timestamp with time zone,
	"proof_url" text,
	"reason" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"family" text NOT NULL,
	"rung" integer,
	"list_price" numeric(14, 2) DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"external_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"organisation_id" uuid,
	"product_id" uuid,
	"product_name" text NOT NULL,
	"family" text NOT NULL,
	"list_price" numeric(14, 2),
	"discount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"fx_rate" numeric(14, 6) DEFAULT 1 NOT NULL,
	"amount_inr" numeric(14, 2) NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" text NOT NULL,
	"reference" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"credited_user_id" uuid,
	"assisted" boolean DEFAULT false NOT NULL,
	"credit_adjusted_by_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"has_instalments" boolean DEFAULT false NOT NULL,
	"proof_url" text,
	"notes" text,
	"campaign" text,
	"raw_payload" jsonb,
	"import_batch_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"rated_by_user_id" uuid,
	"source" text DEFAULT 'sales' NOT NULL,
	"ai_level" integer,
	"umer_level" integer,
	"spending_band" integer,
	"gut_stars" integer,
	"age_band" text,
	"industry" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"user_id" uuid,
	"type" text NOT NULL,
	"reason" text NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text,
	"payload" jsonb,
	"created_by_id" uuid,
	"completed_by_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"role" text DEFAULT 'sales' NOT NULL,
	"team" text,
	"phone" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_assigned_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"event_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"contact_id" uuid
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merges" ADD CONSTRAINT "contact_merges_winner_id_contacts_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merges" ADD CONSTRAINT "contact_merges_loser_id_contacts_id_fk" FOREIGN KEY ("loser_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merges" ADD CONSTRAINT "contact_merges_merged_by_id_users_id_fk" FOREIGN KEY ("merged_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merges" ADD CONSTRAINT "contact_merges_undone_by_id_users_id_fk" FOREIGN KEY ("undone_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_first_owner_id_users_id_fk" FOREIGN KEY ("first_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_reviews" ADD CONSTRAINT "duplicate_reviews_contact_a_id_contacts_id_fk" FOREIGN KEY ("contact_a_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_reviews" ADD CONSTRAINT "duplicate_reviews_contact_b_id_contacts_id_fk" FOREIGN KEY ("contact_b_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_reviews" ADD CONSTRAINT "duplicate_reviews_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_undone_by_id_users_id_fk" FOREIGN KEY ("undone_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_log" ADD CONSTRAINT "ownership_log_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_log" ADD CONSTRAINT "ownership_log_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_log" ADD CONSTRAINT "ownership_log_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_log" ADD CONSTRAINT "ownership_log_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_credited_user_id_users_id_fk" FOREIGN KEY ("credited_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_credit_adjusted_by_id_users_id_fk" FOREIGN KEY ("credit_adjusted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_rated_by_user_id_users_id_fk" FOREIGN KEY ("rated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_id_users_id_fk" FOREIGN KEY ("completed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_row_idx" ON "audit_log" USING btree ("table_name","row_id");--> statement-breakpoint
CREATE INDEX "audit_log_changed_idx" ON "audit_log" USING btree ("changed_at");--> statement-breakpoint
CREATE INDEX "audit_log_user_idx" ON "audit_log" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","id");--> statement-breakpoint
CREATE INDEX "contact_merges_winner_idx" ON "contact_merges" USING btree ("winner_id");--> statement-breakpoint
CREATE INDEX "contact_merges_loser_idx" ON "contact_merges" USING btree ("loser_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_phone_uq" ON "contacts" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "contacts_alt_phones_idx" ON "contacts" USING gin ("alt_phones");--> statement-breakpoint
CREATE INDEX "contacts_alt_emails_idx" ON "contacts" USING gin ("alt_emails");--> statement-breakpoint
CREATE INDEX "contacts_tags_idx" ON "contacts" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "contacts_owner_idx" ON "contacts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "contacts_stage_idx" ON "contacts" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "contacts_grade_idx" ON "contacts" USING btree ("grade");--> statement-breakpoint
CREATE INDEX "contacts_first_door_idx" ON "contacts" USING btree ("first_door");--> statement-breakpoint
CREATE INDEX "contacts_referred_by_idx" ON "contacts" USING btree ("referred_by_id");--> statement-breakpoint
CREATE INDEX "contacts_name_idx" ON "contacts" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "contacts_merged_idx" ON "contacts" USING btree ("merged_into_id");--> statement-breakpoint
CREATE INDEX "contacts_org_idx" ON "contacts" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "contacts_owner_assigned_idx" ON "contacts" USING btree ("owner_assigned_at");--> statement-breakpoint
CREATE INDEX "contacts_name_trgm_idx" ON "contacts" USING gin (lower("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_email_trgm_idx" ON "contacts" USING gin (lower(coalesce("email", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_phone_trgm_idx" ON "contacts" USING gin ("phone_e164" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_has_alt_phones_idx" ON "contacts" USING btree ("id") WHERE cardinality("contacts"."alt_phones") > 0;--> statement-breakpoint
CREATE INDEX "contacts_has_alt_emails_idx" ON "contacts" USING btree ("id") WHERE cardinality("contacts"."alt_emails") > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_reviews_pair_uq" ON "duplicate_reviews" USING btree ("contact_a_id","contact_b_id");--> statement-breakpoint
CREATE INDEX "duplicate_reviews_status_idx" ON "duplicate_reviews" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "enquiries_source_ref_uq" ON "enquiries" USING btree ("source_ref");--> statement-breakpoint
CREATE INDEX "enquiries_contact_idx" ON "enquiries" USING btree ("contact_id","received_at");--> statement-breakpoint
CREATE INDEX "enquiries_channel_idx" ON "enquiries" USING btree ("channel","received_at");--> statement-breakpoint
CREATE INDEX "enquiries_status_idx" ON "enquiries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "enquiries_campaign_idx" ON "enquiries" USING btree ("campaign");--> statement-breakpoint
CREATE INDEX "import_rows_batch_idx" ON "import_rows" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "import_rows_match_idx" ON "import_rows" USING btree ("batch_id","match_result");--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_external_ref_uq" ON "interactions" USING btree ("external_ref");--> statement-breakpoint
CREATE INDEX "interactions_contact_idx" ON "interactions" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "interactions_user_idx" ON "interactions" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "login_attempts_email_idx" ON "login_attempts" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "notifications_contact_idx" ON "notifications" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_email_pending_idx" ON "notifications" USING btree ("created_at") WHERE "notifications"."email" and "notifications"."emailed_at" is null;--> statement-breakpoint
CREATE INDEX "organisations_name_idx" ON "organisations" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "ownership_log_contact_idx" ON "ownership_log" USING btree ("contact_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reference_uq" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "payments_purchase_idx" ON "payments" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "payments_contact_idx" ON "payments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "products_family_idx" ON "products" USING btree ("family");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_reference_uq" ON "purchases" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "purchases_contact_idx" ON "purchases" USING btree ("contact_id","purchased_at");--> statement-breakpoint
CREATE INDEX "purchases_org_idx" ON "purchases" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "purchases_purchased_at_idx" ON "purchases" USING btree ("purchased_at");--> statement-breakpoint
CREATE INDEX "purchases_credited_idx" ON "purchases" USING btree ("credited_user_id");--> statement-breakpoint
CREATE INDEX "ratings_contact_idx" ON "ratings" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_dedupe_uq" ON "tasks" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "tasks_user_status_idx" ON "tasks" USING btree ("user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_contact_idx" ON "tasks" USING btree ("contact_id","type","status");--> statement-breakpoint
CREATE INDEX "tasks_open_type_due_idx" ON "tasks" USING btree ("type","due_at") WHERE "tasks"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_key_uq" ON "webhook_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "webhook_events_source_idx" ON "webhook_events" USING btree ("source","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("received_at");