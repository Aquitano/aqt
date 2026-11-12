CREATE TABLE "t3_runs" (
	"machine_id" uuid,
	"id" text,
	"thread_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"provider" text,
	"status" text NOT NULL,
	"model" text,
	"effort" text,
	"fast" boolean,
	"requested_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempts" integer NOT NULL,
	"native_session_id" text,
	CONSTRAINT "t3_runs_pkey" PRIMARY KEY("machine_id","id")
);
--> statement-breakpoint
CREATE TABLE "t3_threads" (
	"machine_id" uuid,
	"id" text,
	"title" text,
	"project" text,
	"project_root" text,
	"provider" text,
	"created_by" text,
	"creation_source" text,
	"parent_thread_id" text,
	"relationship" text,
	"model" text,
	"effort" text,
	"fast" boolean,
	"branch" text,
	"worktree_path" text,
	"pull_requests" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "t3_threads_pkey" PRIMARY KEY("machine_id","id")
);
--> statement-breakpoint
CREATE INDEX "t3_runs_thread" ON "t3_runs" ("machine_id","thread_id");--> statement-breakpoint
CREATE INDEX "t3_runs_native_session" ON "t3_runs" ("native_session_id");--> statement-breakpoint
CREATE INDEX "t3_runs_requested" ON "t3_runs" ("requested_at");--> statement-breakpoint
CREATE INDEX "t3_threads_created" ON "t3_threads" ("created_at");--> statement-breakpoint
ALTER TABLE "t3_runs" ADD CONSTRAINT "t3_runs_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "t3_threads" ADD CONSTRAINT "t3_threads_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");