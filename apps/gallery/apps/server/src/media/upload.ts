import { db } from "@aqt-gallery/db";
import { artwork, mediaAsset } from "@aqt-gallery/db/schema/gallery";
import sharp, { type Metadata } from "sharp";

import { filenameTitle } from "../api/routers/gallery-helpers";
import { fetchFollowingRedirects, readImageBodyCapped } from "./ssrf-fetch";
import type { MediaStore } from "./store";

const maxFilesPerUpload = 25;
const maxFileSizeBytes = 25 * 1024 * 1024;
/** Decoded-pixel ceiling. The byte cap bounds the compressed input, but a tiny
 * highly-compressed file can still decode to billions of pixels (a decompression
 * bomb), so sharp's decode is capped here too. 100MP comfortably clears legit
 * high-res art scans while blocking the bomb case. */
const maxInputPixels = 100_000_000;

/** Shared zero-length placeholder swapped in for image buffers once written,
 * so the prepared batch doesn't pin every original + thumbnail in memory. */
const EMPTY_BUFFER = Buffer.alloc(0);

/** sharp's detected format is the source of truth for what we store — never
 * the client-declared mime/extension, which is attacker-chosen and can lie
 * about the bytes (e.g. a PNG sent as image/jpeg). Only these four are served. */
const imageFormatToType: Record<
	string,
	{ mimeType: string; extension: string }
> = {
	jpeg: { mimeType: "image/jpeg", extension: "jpg" },
	png: { mimeType: "image/png", extension: "png" },
	webp: { mimeType: "image/webp", extension: "webp" },
	gif: { mimeType: "image/gif", extension: "gif" },
};

export type UploadError =
	| { kind: "NoFilesSupplied" }
	| { kind: "TooManyFiles"; maxFiles: number }
	| { kind: "FileTooLarge"; filename: string; maxFileSizeBytes: number }
	| { kind: "UnsupportedFileType"; filename: string; mimeType: string }
	| { kind: "ImageProcessingFailed"; filename: string; cause: unknown }
	| { kind: "StorageWriteFailed"; filename: string; cause: unknown }
	| { kind: "DatabaseWriteFailed"; cause: unknown }
	| { kind: "RemoteFetchFailed"; url: string; status?: number };

type Failed = { readonly ok: false; readonly error: UploadError };

function failed(error: UploadError): Failed {
	return { ok: false, error };
}

/** Run `work` over the items at most `limit` at a time, preserving order.
 * Ingest is CPU- and network-bound per item, so a whole batch in flight would
 * either pin every decoded image in memory or burst a remote host. */
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<R>,
): Promise<R[]> {
	const queue = items.map((item, index) => ({ item, index }));
	const results = new Array<R>(items.length);
	const worker = async () => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			results[next.index] = await work(next.item);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return results;
}

type UploadFile = {
	readonly artworkId: string;
	readonly assetId: string;
	readonly title: string;
	readonly originalKey: string;
	readonly thumbnailKey: string;
	// Mutable + cleared right after the store write so resident memory stays
	// bounded to roughly one in-flight file instead of the whole batch.
	buffer: Buffer;
	thumbnailBuffer: Buffer;
	readonly width: number | null;
	readonly height: number | null;
	readonly originalFilename: string;
	readonly mimeType: string;
	readonly byteSize: number;
	/** Provenance: the remote URL a URL-import was fetched from. Null for
	 * browser uploads, which have no upstream source. */
	readonly sourceUrl: string | null;
};

export type UploadedArtwork = {
	readonly artworkId: string;
	readonly asset: typeof mediaAsset.$inferSelect;
	readonly title: string;
};

export type UploadResult =
	| { readonly ok: true; readonly uploaded: UploadedArtwork[] }
	| Failed;

export type UploadMediaInput = {
	readonly formData: FormData;
	readonly store: MediaStore;
	readonly userId: string;
};

/** Undo a partially-written batch. Best-effort: the caller is already returning
 * an error, and a failed cleanup must not mask it. */
async function cleanupFiles(
	store: MediaStore,
	files: ReadonlyArray<Pick<UploadFile, "originalKey" | "thumbnailKey">>,
) {
	await Promise.all(
		files
			.flatMap((file) => [file.originalKey, file.thumbnailKey])
			.map((key) => store.delete(key).catch(() => {})),
	);
}

type FormEntry = { value: File; title: string | undefined };

/** Pairs each uploaded file with its optional title and filters both in
 * lockstep, so a dropped (empty) file can never shift the titles out of
 * alignment with the files that survive. */
function filesFromFormData(
	formData: FormData,
): { ok: true; entries: FormEntry[] } | Failed {
	const rawTitles = formData.getAll("titles");
	const entries = formData
		.getAll("files")
		.map((value, index) => ({
			value,
			title:
				typeof rawTitles[index] === "string"
					? (rawTitles[index] as string)
					: undefined,
		}))
		.filter(
			(entry): entry is FormEntry =>
				entry.value instanceof File && entry.value.size > 0,
		);

	if (entries.length === 0) {
		return failed({ kind: "NoFilesSupplied" });
	}

	if (entries.length > maxFilesPerUpload) {
		return failed({ kind: "TooManyFiles", maxFiles: maxFilesPerUpload });
	}

	return { ok: true, entries };
}

/** Shared ingest core: validates an in-memory image, derives a thumbnail,
 * and produces an unwritten UploadFile. Both browser uploads and remote
 * URL imports funnel through here so a downloaded image is stored exactly
 * like an uploaded one. */
type Prepared = { readonly ok: true; readonly file: UploadFile } | Failed;

async function prepareImage(
	userId: string,
	input: {
		readonly bytes: Buffer;
		readonly mimeType: string;
		readonly filename: string;
		readonly title?: string;
		readonly sourceUrl?: string;
	},
): Promise<Prepared> {
	if (input.bytes.byteLength > maxFileSizeBytes) {
		return failed({
			kind: "FileTooLarge",
			filename: input.filename,
			maxFileSizeBytes,
		});
	}

	let metadata: Metadata;
	try {
		metadata = await sharp(input.bytes, {
			limitInputPixels: maxInputPixels,
		}).metadata();
	} catch (cause) {
		return failed({
			kind: "ImageProcessingFailed",
			filename: input.filename,
			cause,
		});
	}

	// The decoded format — not the client/upstream-declared mime — decides
	// what we store, so the persisted type and bytes can never disagree.
	const canonical = metadata.format
		? imageFormatToType[metadata.format]
		: undefined;
	if (!canonical) {
		return failed({
			kind: "UnsupportedFileType",
			filename: input.filename,
			mimeType: input.mimeType,
		});
	}
	const { mimeType, extension } = canonical;
	const animated = metadata.format === "gif";

	// EXIF orientations 5-8 rotate by 90/270deg, swapping the visual width and
	// height. The original bytes are stored verbatim (the browser auto-orients
	// them on display), and the thumbnail is auto-oriented below, so the stored
	// dimensions must be the *visual* ones or the 3D frame is sized to the wrong
	// aspect and the thumbnail/full-res layers disagree.
	const swapWH = (metadata.orientation ?? 1) >= 5;
	const visualWidth = (swapWH ? metadata.height : metadata.width) ?? null;
	const visualHeight = (swapWH ? metadata.width : metadata.height) ?? null;

	const artworkId = crypto.randomUUID();
	const assetId = crypto.randomUUID();
	let thumbnailBuffer: Buffer;
	try {
		thumbnailBuffer = await sharp(input.bytes, {
			animated,
			limitInputPixels: maxInputPixels,
		})
			// Bake in EXIF orientation: webp strips the tag, so without this the
			// thumbnail renders un-rotated while the full-res (browser
			// auto-oriented) renders rotated — the two layers disagree.
			.rotate()
			.resize({
				width: 900,
				height: 1200,
				fit: "inside",
				withoutEnlargement: true,
			})
			.webp({ quality: 82 })
			.toBuffer();
	} catch (cause) {
		return failed({
			kind: "ImageProcessingFailed",
			filename: input.filename,
			cause,
		});
	}

	return {
		ok: true,
		file: {
			artworkId,
			assetId,
			title:
				input.title?.trim() ||
				filenameTitle(input.filename) ||
				"Untitled artwork",
			originalKey: `originals/${userId}/${assetId}.${extension}`,
			thumbnailKey: `thumbs/${userId}/${assetId}.webp`,
			buffer: input.bytes,
			thumbnailBuffer,
			width: visualWidth,
			height: visualHeight,
			originalFilename: input.filename,
			mimeType,
			byteSize: input.bytes.byteLength,
			sourceUrl: input.sourceUrl ?? null,
		},
	};
}

async function prepareUploadFile(
	userId: string,
	file: File,
	title?: string,
): Promise<Prepared> {
	if (file.size > maxFileSizeBytes) {
		return failed({
			kind: "FileTooLarge",
			filename: file.name,
			maxFileSizeBytes,
		});
	}
	let bytes: Buffer;
	try {
		bytes = Buffer.from(await file.arrayBuffer());
	} catch (cause) {
		return failed({
			kind: "ImageProcessingFailed",
			filename: file.name,
			cause,
		});
	}
	return prepareImage(userId, {
		bytes,
		mimeType: file.type,
		filename: file.name,
		title,
	});
}

function filenameFromUrl(url: string) {
	try {
		const last = new URL(url).pathname.split("/").filter(Boolean).pop();
		return last ? decodeURIComponent(last) : "imported-image";
	} catch {
		return "imported-image";
	}
}

const IMAGE_FETCH_USER_AGENT = "aqt-gallery/1.0 (museum image import)";
const MAX_IMAGE_FETCH_REDIRECTS = 5;
const MAX_IMAGE_FETCH_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 10_000;
// Transient upstream throttling/unavailability worth retrying; other 4xx/5xx
// are treated as permanent.
const RETRYABLE_FETCH_STATUS = new Set([429, 503]);

const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds;
 * null when absent or unparseable. */
function retryAfterDelayMs(res: Response): number | null {
	const header = res.headers.get("retry-after");
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const dateMs = Date.parse(header);
	return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

/** Fetch an image, retrying transient throttling (429/503) with backoff that
 * honours Retry-After. Bursting imports at a big host like Wikimedia routinely
 * draws a 429; a few bounded retries clear it without stalling the request, and
 * a Retry-After longer than we'll wait surfaces the error instead. SSRF
 * validation and redirect handling live in the shared ssrf-fetch helper. */
async function fetchImageGuarded(initialUrl: string): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetchFollowingRedirects(initialUrl, {
			userAgent: IMAGE_FETCH_USER_AGENT,
			maxRedirects: MAX_IMAGE_FETCH_REDIRECTS,
		});
		if (
			!RETRYABLE_FETCH_STATUS.has(res.status) ||
			attempt >= MAX_IMAGE_FETCH_RETRIES
		) {
			return res;
		}
		const retryAfter = retryAfterDelayMs(res);
		if (retryAfter !== null && retryAfter > MAX_RETRY_DELAY_MS) {
			return res;
		}
		const backoff = Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** attempt);
		await res.body?.cancel();
		await delay(retryAfter ?? backoff);
	}
}

/** Downloads a remote image once and routes it through the shared ingest,
 * so the gallery never depends on a live third-party URL afterwards. */
async function prepareUrlImage(
	userId: string,
	item: { readonly url: string; readonly title?: string },
): Promise<Prepared> {
	let res: Response;
	try {
		res = await fetchImageGuarded(item.url);
	} catch {
		return failed({ kind: "RemoteFetchFailed", url: item.url });
	}
	if (!res.ok) {
		return failed({
			kind: "RemoteFetchFailed",
			url: item.url,
			status: res.status,
		});
	}
	const contentType =
		res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
	let bytes: Buffer | null;
	try {
		bytes = await readImageBodyCapped(res, maxFileSizeBytes);
	} catch {
		return failed({ kind: "RemoteFetchFailed", url: item.url });
	}
	if (!bytes) {
		return failed({
			kind: "FileTooLarge",
			filename: filenameFromUrl(item.url),
			maxFileSizeBytes,
		});
	}
	return prepareImage(userId, {
		bytes,
		mimeType: contentType,
		filename: filenameFromUrl(item.url),
		title: item.title,
		sourceUrl: item.url,
	});
}

async function writeUploadFiles(
	store: MediaStore,
	files: ReadonlyArray<UploadFile>,
): Promise<{ ok: true } | Failed> {
	for (const file of files) {
		try {
			await store.put(file.originalKey, file.buffer, file.mimeType);
			await store.put(file.thumbnailKey, file.thumbnailBuffer, "image/webp");
		} catch (cause) {
			await cleanupFiles(store, files);
			return failed({
				kind: "StorageWriteFailed",
				filename: file.originalFilename,
				cause,
			});
		}
		// Release the large image buffers now that they're stored; the DB insert
		// below only reads keys/metadata, never the bytes.
		file.buffer = EMPTY_BUFFER;
		file.thumbnailBuffer = EMPTY_BUFFER;
	}
	return { ok: true };
}

async function insertUploadedArtworks(
	store: MediaStore,
	userId: string,
	files: ReadonlyArray<UploadFile>,
): Promise<UploadResult> {
	try {
		const uploaded = await db.transaction(async (tx) => {
			const inserted: UploadedArtwork[] = [];

			for (const file of files) {
				await tx.insert(artwork).values({
					id: file.artworkId,
					userId,
					title: file.title,
					artworkType: "other",
					primaryAssetId: file.assetId,
					sourceUrl: file.sourceUrl,
				});

				const rows = await tx
					.insert(mediaAsset)
					.values({
						id: file.assetId,
						userId,
						artworkId: file.artworkId,
						originalFilename: file.originalFilename,
						mimeType: file.mimeType,
						byteSize: file.byteSize,
						width: file.width,
						height: file.height,
						storagePath: file.originalKey,
						thumbnailPath: file.thumbnailKey,
					})
					.returning();

				const asset = rows[0];

				if (!asset) {
					throw new Error("Media asset insert returned no rows");
				}

				inserted.push({
					artworkId: file.artworkId,
					asset,
					title: file.title,
				});
			}

			return inserted;
		});
		return { ok: true, uploaded };
	} catch (cause) {
		await cleanupFiles(store, files);
		return failed({ kind: "DatabaseWriteFailed", cause });
	}
}

/** Collect the prepared files, short-circuiting on the first failure so a bad
 * item never leaves half a batch stored. */
function collectPrepared(
	prepared: ReadonlyArray<Prepared>,
): { ok: true; files: UploadFile[] } | Failed {
	const files: UploadFile[] = [];
	for (const result of prepared) {
		if (!result.ok) return result;
		files.push(result.file);
	}
	return { ok: true, files };
}

async function storePrepared(
	store: MediaStore,
	userId: string,
	prepared: ReadonlyArray<Prepared>,
): Promise<UploadResult> {
	const collected = collectPrepared(prepared);
	if (!collected.ok) return collected;
	const written = await writeUploadFiles(store, collected.files);
	if (!written.ok) return written;
	return insertUploadedArtworks(store, userId, collected.files);
}

export async function uploadMedia({
	formData,
	store,
	userId,
}: UploadMediaInput): Promise<UploadResult> {
	const parsed = filesFromFormData(formData);
	if (!parsed.ok) return parsed;
	const prepared = await mapWithConcurrency(parsed.entries, 2, (entry) =>
		prepareUploadFile(userId, entry.value, entry.title || undefined),
	);
	return storePrepared(store, userId, prepared);
}

export type ImportUrlsInput = {
	readonly items: ReadonlyArray<{
		readonly url: string;
		readonly title?: string;
	}>;
	readonly store: MediaStore;
	readonly userId: string;
};

/** Import flow for remote images: each URL is downloaded once, processed, and
 * stored as a media asset — identical stored result to an upload, so the rest
 * of the app never sees the external URL. */
export async function importMediaFromUrls({
	items,
	store,
	userId,
}: ImportUrlsInput): Promise<UploadResult> {
	if (items.length === 0) {
		return failed({ kind: "NoFilesSupplied" });
	}
	if (items.length > maxFilesPerUpload) {
		return failed({ kind: "TooManyFiles", maxFiles: maxFilesPerUpload });
	}
	const prepared = await mapWithConcurrency(items, 2, (item) =>
		prepareUrlImage(userId, item),
	);
	return storePrepared(store, userId, prepared);
}

export function uploadErrorResponse(error: UploadError) {
	switch (error.kind) {
		case "NoFilesSupplied":
			return { status: 400 as const, body: { error: "No files supplied" } };
		case "TooManyFiles":
			return {
				status: 400 as const,
				body: { error: `Upload at most ${error.maxFiles} files at a time` },
			};
		case "FileTooLarge":
			return {
				status: 413 as const,
				body: {
					error: `${error.filename} exceeds the ${Math.floor(error.maxFileSizeBytes / 1024 / 1024)}MB limit`,
				},
			};
		case "UnsupportedFileType":
			return {
				status: 415 as const,
				body: {
					error: `Unsupported file type: ${error.mimeType || error.filename}`,
				},
			};
		case "ImageProcessingFailed":
			return {
				status: 400 as const,
				body: { error: `Could not process image: ${error.filename}` },
			};
		case "RemoteFetchFailed":
			return {
				status: 502 as const,
				body: {
					error: `Could not download image${
						error.status ? ` (HTTP ${error.status})` : ""
					}`,
				},
			};
		case "StorageWriteFailed":
		case "DatabaseWriteFailed":
			return { status: 500 as const, body: { error: "Upload failed" } };
	}
}
