CREATE TABLE "stories" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"state_detail" text DEFAULT '' NOT NULL,
	"bible" jsonb NOT NULL,
	"raw_json" text NOT NULL,
	"story_state" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "story_masters" (
	"story_id" text NOT NULL,
	"master_key" text NOT NULL,
	"kind" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text DEFAULT '' NOT NULL,
	"prompt_parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"must_match" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'missing' NOT NULL,
	"approved_asset_id" text,
	"approved_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_masters_story_id_master_key_pk" PRIMARY KEY("story_id","master_key")
);
--> statement-breakpoint
ALTER TABLE "story_masters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_events" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "story_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "story_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "crop_seed" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "prompt_parts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "master_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "crop_enabled" boolean;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "crop_salt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "voice_mode" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_events" ADD COLUMN "story_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "story_id" text;--> statement-breakpoint
ALTER TABLE "story_masters" ADD CONSTRAINT "story_masters_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_story_key_idx" ON "assets" USING btree ("story_id","asset_key","status");--> statement-breakpoint
CREATE INDEX "task_events_story_idx" ON "task_events" USING btree ("story_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_story_idx" ON "tasks" USING btree ("story_id","type","scope");