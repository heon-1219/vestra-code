CREATE TABLE "project_digests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"basis" text NOT NULL,
	"about" text NOT NULL,
	"words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_digests" ADD CONSTRAINT "project_digests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_digests_project_basis_idx" ON "project_digests" USING btree ("project_id","basis");