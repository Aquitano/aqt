/** One-off copy of a local upload directory into the configured S3 bucket, for
 * the cut-over from disk storage. Only the archival originals and thumbnails
 * move; the proxied-image cache is derived and regenerates on demand. Safe to
 * re-run — an object that already exists is left alone.
 *
 * Run from apps/server: bun run media:migrate
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { env } from "@aqt-gallery/env/server";

import { createS3Store, s3ClientFromEnv } from "../media/store";

const client = s3ClientFromEnv();
if (!client) {
	throw new Error(
		"Set S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY before migrating",
	);
}

const store = createS3Store(client);
const root = path.resolve(env.UPLOAD_DIR);

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
};

async function* walk(dir: string): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

let copied = 0;
let skipped = 0;

for (const mediaDir of ["originals", "thumbs"]) {
	for await (const filePath of walk(path.join(root, mediaDir))) {
		const key = path.relative(root, filePath).split(path.sep).join("/");
		const extension = path.extname(filePath).slice(1).toLowerCase();
		const contentType = CONTENT_TYPE_BY_EXTENSION[extension];
		if (!contentType) {
			console.warn(`skipped ${key}: unsupported extension`);
			skipped++;
			continue;
		}
		if (await store.head(key)) {
			skipped++;
			continue;
		}
		await store.put(key, await Bun.file(filePath).bytes(), contentType);
		copied++;
	}
}

console.log(`copied ${copied} objects from ${root}, skipped ${skipped}`);
