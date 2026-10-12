CREATE TABLE "pricing_rules" (
	"model" text PRIMARY KEY,
	"rule" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
