CREATE TABLE "dashboard_logins" (
	"token_hash" text PRIMARY KEY,
	"state" text NOT NULL,
	"verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_sessions" (
	"token_hash" text PRIMARY KEY,
	"subject" text NOT NULL,
	"name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
