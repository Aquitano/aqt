import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { db } from "@aqt-gallery/db";
import { artwork, mediaAsset } from "@aqt-gallery/db/schema/gallery";
import { Data, Effect } from "effect";
import sharp from "sharp";

import { filenameTitle } from "../api/routers/gallery-helpers";

const maxFilesPerUpload = 25;
const maxFileSizeBytes = 25 * 1024 * 1024;

const imageMimeExtensions = new Map([
	["image/jpeg", "jpg"],
	["image/png", "png"],
	["image/webp", "webp"],
	["image/gif", "gif"],
]);

declare const emptyFields: unique symbol;
type EmptyFields = { readonly [emptyFields]?: never };

export class NoFilesSupplied extends Data.TaggedError(
	"NoFilesSupplied",
)<EmptyFields> {}

export class TooManyFiles extends Data.TaggedError("TooManyFiles")<{
	readonly maxFiles: number;
}> {}

export class FileTooLarge extends Data.TaggedError("FileTooLarge")<{
	readonly filename: string;
	readonly maxFileSizeBytes: number;
}> {}

export class UnsupportedFileType extends Data.TaggedError(
	"UnsupportedFileType",
)<{
	readonly filename: string;
	readonly mimeType: string;
}> {}

export class ImageProcessingFailed extends Data.TaggedError(
	"ImageProcessingFailed",
)<{
	readonly filename: string;
	readonly cause: unknown;
}> {}

export class StorageWriteFailed extends Data.TaggedError("StorageWriteFailed")<{
	readonly filename: string;
	readonly cause: unknown;
}> {}

export class DatabaseWriteFailed extends Data.TaggedError(
	"DatabaseWriteFailed",
)<{
	readonly cause: unknown;
}> {}

export type UploadError =
	| NoFilesSupplied
	| TooManyFiles
	| FileTooLarge
	| UnsupportedFileType
	| ImageProcessingFailed
	| StorageWriteFailed
	| DatabaseWriteFailed;

type UploadFile = {
	readonly file: File;
	readonly artworkId: string;
	readonly assetId: string;
	readonly title: string;
	readonly extension: string;
	readonly originalPath: string;
	readonly thumbnailPath: string;
	readonly buffer: Buffer;
	readonly thumbnailBuffer: Buffer;
	readonly width: number | null;
	readonly height: number | null;
};

export type UploadedArtwork = {
	readonly artworkId: string;
	readonly asset: typeof mediaAsset.$inferSelect;
	readonly title: string;
};

export type UploadMediaInput = {
	readonly formData: FormData;
	readonly uploadRoot: string;
	readonly userId: string;
};

function uploadDirs(uploadRoot: string, userId: string) {
	return {
		originalsDir: path.join(uploadRoot, "originals", userId),
		thumbsDir: path.join(uploadRoot, "thumbs", userId),
	};
}

function deleteIfExists(filePath: string) {
	return Effect.tryPromise({
		try: () =>
			unlink(filePath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") {
					throw error;
				}
			}),
		catch: (cause) => cause,
	});
}

function cleanupFiles(
	files: ReadonlyArray<Pick<UploadFile, "originalPath" | "thumbnailPath">>,
) {
	return Effect.all(
		files.flatMap((file) => [
			deleteIfExists(file.originalPath),
			deleteIfExists(file.thumbnailPath),
		]),
		{ concurrency: 4 },
	).pipe(Effect.orDie);
}

function filesFromFormData(formData: FormData) {
	const files = formData
		.getAll("files")
		.filter((value): value is File => value instanceof File && value.size > 0);

	if (files.length === 0) {
		return Effect.fail(new NoFilesSupplied({}));
	}

	if (files.length > maxFilesPerUpload) {
		return Effect.fail(new TooManyFiles({ maxFiles: maxFilesPerUpload }));
	}

	return Effect.succeed(files);
}

function prepareUploadFile(uploadRoot: string, userId: string, file: File) {
	return Effect.gen(function* () {
		if (file.size > maxFileSizeBytes) {
			return yield* new FileTooLarge({ filename: file.name, maxFileSizeBytes });
		}

		const extension = imageMimeExtensions.get(file.type);

		if (!extension) {
			return yield* new UnsupportedFileType({
				filename: file.name,
				mimeType: file.type,
			});
		}

		const artworkId = crypto.randomUUID();
		const assetId = crypto.randomUUID();
		const { originalsDir, thumbsDir } = uploadDirs(uploadRoot, userId);
		const originalPath = path.join(originalsDir, `${assetId}.${extension}`);
		const thumbnailPath = path.join(thumbsDir, `${assetId}.webp`);
		const buffer = yield* Effect.tryPromise({
			try: async () => Buffer.from(await file.arrayBuffer()),
			catch: (cause) =>
				new ImageProcessingFailed({ filename: file.name, cause }),
		});

		const image = sharp(buffer, { animated: file.type === "image/gif" });
		const metadata = yield* Effect.tryPromise({
			try: () => image.metadata(),
			catch: (cause) =>
				new ImageProcessingFailed({ filename: file.name, cause }),
		});
		const thumbnailBuffer = yield* Effect.tryPromise({
			try: () =>
				sharp(buffer, { animated: file.type === "image/gif" })
					.resize({
						width: 900,
						height: 1200,
						fit: "inside",
						withoutEnlargement: true,
					})
					.webp({ quality: 82 })
					.toBuffer(),
			catch: (cause) =>
				new ImageProcessingFailed({ filename: file.name, cause }),
		});

		return {
			file,
			artworkId,
			assetId,
			title: filenameTitle(file.name) || "Untitled artwork",
			extension,
			originalPath,
			thumbnailPath,
			buffer,
			thumbnailBuffer,
			width: metadata.width ?? null,
			height: metadata.height ?? null,
		} satisfies UploadFile;
	});
}

function writeUploadFiles(files: ReadonlyArray<UploadFile>) {
	return Effect.tryPromise({
		try: async () => {
			for (const file of files) {
				await mkdir(path.dirname(file.originalPath), { recursive: true });
				await mkdir(path.dirname(file.thumbnailPath), { recursive: true });
				await Bun.write(file.originalPath, file.buffer);
				await Bun.write(file.thumbnailPath, file.thumbnailBuffer);
			}
			return files;
		},
		catch: (cause) => new StorageWriteFailed({ filename: "upload", cause }),
	}).pipe(Effect.tapError(() => cleanupFiles(files)));
}

function insertUploadedArtworks(
	userId: string,
	files: ReadonlyArray<UploadFile>,
) {
	return Effect.tryPromise({
		try: () =>
			db.transaction(async (tx) => {
				const uploaded: UploadedArtwork[] = [];

				for (const file of files) {
					await tx.insert(artwork).values({
						id: file.artworkId,
						userId,
						title: file.title,
						artworkType: "other",
						primaryAssetId: file.assetId,
					});

					const rows = await tx
						.insert(mediaAsset)
						.values({
							id: file.assetId,
							userId,
							artworkId: file.artworkId,
							originalFilename: file.file.name,
							mimeType: file.file.type,
							byteSize: file.file.size,
							width: file.width,
							height: file.height,
							storagePath: file.originalPath,
							thumbnailPath: file.thumbnailPath,
						})
						.returning();

					const asset = rows[0];

					if (!asset) {
						throw new Error("Media asset insert returned no rows");
					}

					uploaded.push({
						artworkId: file.artworkId,
						asset,
						title: file.title,
					});
				}

				return uploaded;
			}),
		catch: (cause) => new DatabaseWriteFailed({ cause }),
	}).pipe(Effect.tapError(() => cleanupFiles(files)));
}

export function uploadMedia({
	formData,
	uploadRoot,
	userId,
}: UploadMediaInput) {
	return Effect.gen(function* () {
		const files = yield* filesFromFormData(formData);
		const prepared = yield* Effect.all(
			files.map((file) => prepareUploadFile(uploadRoot, userId, file)),
			{
				concurrency: 2,
			},
		);

		yield* writeUploadFiles(prepared);
		return yield* insertUploadedArtworks(userId, prepared);
	});
}

export function uploadErrorResponse(error: UploadError) {
	switch (error._tag) {
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
		case "StorageWriteFailed":
		case "DatabaseWriteFailed":
			return { status: 500 as const, body: { error: "Upload failed" } };
	}
}
