CREATE TABLE "commit_links" (
	"repo" text,
	"sha" text,
	"conversation_id" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commit_links_pkey" PRIMARY KEY("repo","sha")
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"repo" text,
	"sha" text,
	"parents" text[] NOT NULL,
	"authored_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"subject" text NOT NULL,
	"ref" text NOT NULL,
	"on_default_branch" boolean NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commits_pkey" PRIMARY KEY("repo","sha")
);
--> statement-breakpoint
CREATE TABLE "repository_paths" (
	"machine_id" uuid,
	"path" text,
	"repo" text NOT NULL,
	"remote" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_paths_pkey" PRIMARY KEY("machine_id","path")
);
--> statement-breakpoint
CREATE INDEX "commit_links_conversation" ON "commit_links" ("conversation_id");--> statement-breakpoint
CREATE INDEX "commits_repo_authored" ON "commits" ("repo","authored_at");--> statement-breakpoint
CREATE INDEX "repository_paths_repo" ON "repository_paths" ("repo");--> statement-breakpoint
ALTER TABLE "commit_links" ADD CONSTRAINT "commit_links_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "commit_links" ADD CONSTRAINT "commit_links_repo_sha_commits_repo_sha_fkey" FOREIGN KEY ("repo","sha") REFERENCES "commits"("repo","sha") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repository_paths" ADD CONSTRAINT "repository_paths_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");