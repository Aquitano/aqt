CREATE TABLE "blobs" (
	"sha256" text PRIMARY KEY,
	"data" bytea NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_blobs" (
	"record_id" bigint,
	"sha256" text,
	CONSTRAINT "record_blobs_pkey" PRIMARY KEY("record_id","sha256")
);
--> statement-breakpoint
CREATE INDEX "record_blobs_sha256" ON "record_blobs" ("sha256");--> statement-breakpoint
ALTER TABLE "record_blobs" ADD CONSTRAINT "record_blobs_record_id_source_records_id_fkey" FOREIGN KEY ("record_id") REFERENCES "source_records"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_blobs" ADD CONSTRAINT "record_blobs_sha256_blobs_sha256_fkey" FOREIGN KEY ("sha256") REFERENCES "blobs"("sha256");