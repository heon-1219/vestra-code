CREATE TYPE "public"."project_source" AS ENUM('github', 'upload');--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "repo_owner" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "repo_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "repo_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "default_branch" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source" "project_source" DEFAULT 'github' NOT NULL;