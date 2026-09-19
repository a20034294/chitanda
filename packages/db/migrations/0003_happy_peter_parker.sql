CREATE TABLE "analysis_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"matched" boolean NOT NULL,
	"score_basis_points" integer NOT NULL,
	"reason" text NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"uncertainties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"request_id" text,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"source_item_version_id" uuid NOT NULL,
	"analysis_result_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text DEFAULT 'unread' NOT NULL,
	"severity" text DEFAULT 'normal' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "task_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"source_item_version_id" uuid NOT NULL,
	"collection_run_id" uuid NOT NULL,
	"collection_outcome" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"deterministic_matched" boolean DEFAULT false NOT NULL,
	"effective_matched" boolean,
	"filter_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"analyzed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN "analysis_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN "candidate_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN "event_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN "analysis_error_code" text;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN "analysis_error_message" text;--> statement-breakpoint
ALTER TABLE "task_run_items" ADD COLUMN "source_item_version_id" uuid;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_candidate_id_task_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."task_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_source_item_version_id_source_item_versions_id_fk" FOREIGN KEY ("source_item_version_id") REFERENCES "public"."source_item_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_analysis_result_id_analysis_results_id_fk" FOREIGN KEY ("analysis_result_id") REFERENCES "public"."analysis_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_candidates" ADD CONSTRAINT "task_candidates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_candidates" ADD CONSTRAINT "task_candidates_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_candidates" ADD CONSTRAINT "task_candidates_source_item_version_id_source_item_versions_id_fk" FOREIGN KEY ("source_item_version_id") REFERENCES "public"."source_item_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_candidates" ADD CONSTRAINT "task_candidates_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_results_candidate_idx" ON "analysis_results" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "events_task_id_idx" ON "events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "events_state_created_at_idx" ON "events" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_candidates_task_version_idx" ON "task_candidates" USING btree ("task_id","source_item_version_id");--> statement-breakpoint
CREATE INDEX "task_candidates_task_id_idx" ON "task_candidates" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_candidates_status_idx" ON "task_candidates" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_feedback_event_user_idx" ON "user_feedback" USING btree ("event_id","user_id");--> statement-breakpoint
ALTER TABLE "task_run_items" ADD CONSTRAINT "task_run_items_source_item_version_id_source_item_versions_id_fk" FOREIGN KEY ("source_item_version_id") REFERENCES "public"."source_item_versions"("id") ON DELETE cascade ON UPDATE no action;
