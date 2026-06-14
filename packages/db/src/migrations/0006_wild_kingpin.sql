ALTER TABLE "account" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verification" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "account" CASCADE;--> statement-breakpoint
DROP TABLE "session" CASCADE;--> statement-breakpoint
DROP TABLE "user" CASCADE;--> statement-breakpoint
DROP TABLE "verification" CASCADE;--> statement-breakpoint
-- IF EXISTS: "DROP TABLE user CASCADE" above already removes these FK
-- constraints, so dropping them again must not error.
ALTER TABLE "artwork" DROP CONSTRAINT IF EXISTS "artwork_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "media_asset" DROP CONSTRAINT IF EXISTS "media_asset_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "tag" DROP CONSTRAINT IF EXISTS "tag_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "art_group" DROP CONSTRAINT IF EXISTS "art_group_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "api_token" DROP CONSTRAINT IF EXISTS "api_token_user_id_user_id_fk";
