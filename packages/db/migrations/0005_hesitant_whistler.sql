CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"mode" text NOT NULL,
	"schedule_bucket" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"provider_message_id" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_event_channel_bucket_idx" ON "deliveries" USING btree ("event_id","user_id","channel","schedule_bucket");--> statement-breakpoint
CREATE INDEX "deliveries_status_scheduled_for_idx" ON "deliveries" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "deliveries_user_id_idx" ON "deliveries" USING btree ("user_id");