CREATE TABLE "agents" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"info" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text,
	"asset_key" text NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint,
	"sha256" text,
	"width" integer,
	"height" integer,
	"duration_sec" double precision,
	"status" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"episode_number" integer NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"state_detail" text DEFAULT '' NOT NULL,
	"episode" jsonb NOT NULL,
	"raw_json" text NOT NULL,
	"estimate" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_render_at" timestamp with time zone,
	"approved_publish_at" timestamp with time zone,
	"outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"youtube_url" text,
	"youtube_video_id" text,
	"published_at" timestamp with time zone,
	"error" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"project_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"order" integer NOT NULL,
	"type" text NOT NULL,
	"narration" text DEFAULT '' NOT NULL,
	"final_prompt" text,
	"negative_prompt" text,
	"image_attempts" integer DEFAULT 0 NOT NULL,
	"audio_duration_sec" double precision,
	"start_sec" double precision,
	"end_sec" double precision,
	"qa" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_project_id_segment_id_pk" PRIMARY KEY("project_id","segment_id")
);
--> statement-breakpoint
CREATE TABLE "sfx_cache" (
	"clip_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"source_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"license" text NOT NULL,
	"license_url" text DEFAULT '' NOT NULL,
	"source_url" text DEFAULT '' NOT NULL,
	"attribution_required" boolean DEFAULT false NOT NULL,
	"duration_sec" double precision,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sfx_cues" (
	"project_id" text NOT NULL,
	"cue_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected_index" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sfx_cues_project_id_cue_id_pk" PRIMARY KEY("project_id","cue_id")
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"status" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"backoff_sec" integer DEFAULT 60 NOT NULL,
	"timeout_minutes" integer DEFAULT 60 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" text,
	"leased_by" text,
	"lease_expires_at" timestamp with time zone,
	"first_leased_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text,
	"provider" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" double precision NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sfx_cues" ADD CONSTRAINT "sfx_cues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_idx" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "assets_project_key_idx" ON "assets" USING btree ("project_id","asset_key","status");--> statement-breakpoint
CREATE INDEX "projects_series_idx" ON "projects" USING btree ("series_id","episode_number");--> statement-breakpoint
CREATE INDEX "task_events_project_idx" ON "task_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_queue_idx" ON "tasks" USING btree ("kind","status","available_at");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id","type","scope");--> statement-breakpoint
CREATE INDEX "usage_provider_idx" ON "usage_events" USING btree ("provider","created_at");