CREATE TABLE "channel_characters" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"reference_assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin_story_id" text NOT NULL,
	"masters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_characters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "line_timings" jsonb DEFAULT '[]'::jsonb NOT NULL;