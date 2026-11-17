CREATE TABLE "record_segments" (
	"id" bigserial PRIMARY KEY,
	"provider" text NOT NULL,
	"conversation_key" text NOT NULL,
	"data" bytea NOT NULL,
	"records" integer NOT NULL,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_segments" ALTER COLUMN "data" SET STORAGE EXTERNAL;--> statement-breakpoint
ALTER TABLE "source_records" ADD COLUMN "segment_ref" bigint;--> statement-breakpoint
ALTER TABLE "source_records" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "record_segments_conversation" ON "record_segments" ("provider","conversation_key");--> statement-breakpoint
CREATE INDEX "source_records_unsealed" ON "source_records" ("provider","conversation_key","ingested_at") WHERE "payload" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "source_records_segment" ON "source_records" ("segment_ref") WHERE "segment_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_segment_ref_record_segments_id_fkey" FOREIGN KEY ("segment_ref") REFERENCES "record_segments"("id");--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_payload_or_segment" CHECK (("payload" IS NULL) <> ("segment_ref" IS NULL));