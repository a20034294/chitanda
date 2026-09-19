CREATE TABLE "collection_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dedupe_key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_runs_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "connector_cursors" (
	"task_id" uuid NOT NULL,
	"source_index" integer NOT NULL,
	"connector_id" text NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"etag" text,
	"last_modified" text,
	"last_succeeded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_cursors_task_id_source_index_pk" PRIMARY KEY("task_id","source_index")
);
--> statement-breakpoint
CREATE TABLE "source_item_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"normalized" jsonb NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" text NOT NULL,
	"source_key" text NOT NULL,
	"external_id" text NOT NULL,
	"canonical_url" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"author" text,
	"published_at" timestamp with time zone,
	"language" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_run_items" (
	"run_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_run_items_run_id_source_item_id_pk" PRIMARY KEY("run_id","source_item_id")
);
--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_cursors" ADD CONSTRAINT "connector_cursors_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_versions" ADD CONSTRAINT "source_item_versions_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run_items" ADD CONSTRAINT "task_run_items_run_id_collection_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."collection_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run_items" ADD CONSTRAINT "task_run_items_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_runs_task_id_idx" ON "collection_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "collection_runs_status_idx" ON "collection_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "collection_runs_created_at_idx" ON "collection_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_item_versions_hash_idx" ON "source_item_versions" USING btree ("source_item_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "source_item_versions_number_idx" ON "source_item_versions" USING btree ("source_item_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "source_items_identity_idx" ON "source_items" USING btree ("connector_id","source_key","external_id");--> statement-breakpoint
CREATE INDEX "source_items_canonical_url_idx" ON "source_items" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "source_items_last_seen_at_idx" ON "source_items" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "task_run_items_source_item_id_idx" ON "task_run_items" USING btree ("source_item_id");