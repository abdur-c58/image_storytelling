CREATE TABLE "episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"active_version_id" text,
	"version_counter" integer DEFAULT 0 NOT NULL,
	"migrated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "episodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "story_state_snapshots" (
	"project_id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL,
	"episode_number" integer NOT NULL,
	"version" integer NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "story_state_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "bible" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "raw_json" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "story_state" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "episode_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "needs_revalidation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "revalidation" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "migrated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "bible_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "defaults_override" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_active_version_id_projects_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_state_snapshots" ADD CONSTRAINT "story_state_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_state_snapshots" ADD CONSTRAINT "story_state_snapshots_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_story_number_idx" ON "episodes" USING btree ("story_id","number");--> statement-breakpoint
CREATE INDEX "snapshots_story_episode_idx" ON "story_state_snapshots" USING btree ("story_id","episode_number");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_episode_version_idx" ON "projects" USING btree ("episode_id","version");
--> statement-breakpoint
-- Data migration (schema 2.3): every project becomes version N of an episode inside a story folder.
UPDATE "stories" SET "status" = CASE WHEN "archived" THEN 'archived' ELSE 'active' END, "bible_version" = 1;--> statement-breakpoint
INSERT INTO "stories" ("id", "title", "description", "state", "state_detail", "status", "bible_version")
SELECT 'unsorted', 'Unsorted', 'Projects created before story folders. Add a story bible here, or leave them as they are.', 'NO_BIBLE', 'No story bible yet.', 'active', 0
WHERE EXISTS (SELECT 1 FROM "projects" WHERE "story_id" IS NULL)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "projects" p SET "story_id" = 'unsorted', "episode_number" = n."rn"
FROM (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id")
    + COALESCE((SELECT max("episode_number") FROM "projects" WHERE "story_id" = 'unsorted'), 0) AS "rn"
  FROM "projects" WHERE "story_id" IS NULL
) n
WHERE p."id" = n."id";--> statement-breakpoint
UPDATE "projects" SET "migrated" = true;--> statement-breakpoint
INSERT INTO "episodes" ("id", "story_id", "number", "title", "migrated", "created_at", "updated_at")
SELECT 'epi_' || substr(md5("story_id" || ':' || "episode_number"), 1, 20), "story_id", "episode_number",
  (array_agg("title" ORDER BY "created_at" DESC))[1], true, min("created_at"), max("updated_at")
FROM "projects" WHERE "story_id" IS NOT NULL
GROUP BY "story_id", "episode_number";--> statement-breakpoint
UPDATE "projects" p SET "episode_id" = e."id", "version" = v."rn"
FROM (SELECT "id", row_number() OVER (PARTITION BY "story_id", "episode_number" ORDER BY "created_at", "id") AS "rn" FROM "projects") v,
  "episodes" e
WHERE p."id" = v."id" AND e."story_id" = p."story_id" AND e."number" = p."episode_number";--> statement-breakpoint
UPDATE "episodes" e SET "version_counter" = x."maxv", "active_version_id" = x."active"
FROM (
  SELECT "episode_id", max("version") AS "maxv", (array_agg("id" ORDER BY "archived" ASC, "version" DESC))[1] AS "active"
  FROM "projects" WHERE "episode_id" IS NOT NULL GROUP BY "episode_id"
) x
WHERE e."id" = x."episode_id";--> statement-breakpoint
UPDATE "tasks" SET "status" = 'cancelled'
WHERE "status" IN ('queued', 'leased') AND "project_id" IN (
  SELECT p."id" FROM "projects" p JOIN "episodes" e ON e."id" = p."episode_id" WHERE e."active_version_id" <> p."id"
);--> statement-breakpoint
UPDATE "projects" p SET "archived" = true FROM "episodes" e WHERE e."id" = p."episode_id" AND e."active_version_id" <> p."id";--> statement-breakpoint
INSERT INTO "story_state_snapshots" ("project_id", "story_id", "episode_number", "version", "state")
SELECT "id", "story_id", "episode_number", "version", "outputs"->'story_state_end'
FROM "projects"
WHERE "story_id" IS NOT NULL AND jsonb_typeof("outputs"->'story_state_end') = 'object';
