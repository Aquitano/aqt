import { env } from "@aqt/gallery-env/web";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { useTRPC } from "@/utils/trpc";

/** What `POST /media/upload` answers with, parsed before it is read. */
const uploadResponse = z.object({
  uploaded: z.array(z.object({ artworkId: z.string() })).optional(),
  error: z.string().optional(),
});

/** The server accepts at most this many files/URLs per request. */
const MAX_PER_REQUEST = 25;
/** How many remote-URL downloads to run at once. */
const URL_CONCURRENCY = 3;

export type ImportSource = "file" | "url";
export type ImportStatus = "ready" | "uploading" | "done" | "error";

export type ImportItem = {
  /** Stable client id for list keys + per-item updates. */
  id: string;
  source: ImportSource;
  /** Editable title; defaults from the filename or URL. */
  title: string;
  file?: File;
  url?: string;
  /** Object URL (file) or the remote URL (url) used for the thumbnail. */
  previewUrl: string;
  status: ImportStatus;
  error?: string;
  artworkId?: string;
};

export type ImportResult = {
  importedArtworkIds: string[];
  imported: number;
  failed: number;
};

function titleFromFilename(name: string): string {
  const base = name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return base || "Untitled artwork";
}

function titleFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? titleFromFilename(decodeURIComponent(last)) : "Imported image";
  } catch {
    return "Imported image";
  }
}

/** Pulls http(s) URLs out of pasted/typed text, one candidate per line. */
function parseUrls(raw: string): string[] {
  return raw
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const current = items[cursor++];
      if (current !== undefined) await worker(current);
    }
  });
  await Promise.all(runners);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * A single staging queue for everything being imported — files and remote
 * URLs alike. Items are added from drops, the file picker, clipboard pastes,
 * or pasted URL text; `runImport` ships them in server-sized batches (files
 * via the upload endpoint, URLs individually so one bad link can't sink the
 * rest) and reports per-item status as it goes.
 */
export function useImportQueue() {
  const trpc = useTRPC();
  const importFromUrl = useMutation(trpc.artworks.importFromUrl.mutationOptions());

  const [items, setItems] = useState<ImportItem[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  // Latest items, for async import logic that shouldn't re-bind on each change.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Object URLs we created and must revoke to avoid leaks.
  const objectUrls = useRef<Set<string>>(new Set());

  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const patch = useCallback((id: string, partial: Partial<ImportItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...partial } : item)));
  }, []);

  const addFiles = useCallback((incoming: Iterable<File>): number => {
    const images = Array.from(incoming).filter(
      (file) => file.type.startsWith("image/") && file.size > 0,
    );
    if (images.length === 0) return 0;
    let added = 0;
    setItems((prev) => {
      const seen = new Set(
        prev.filter((item) => item.file).map((item) => `${item.file?.name}:${item.file?.size}`),
      );
      const next: ImportItem[] = [];
      for (const file of images) {
        const key = `${file.name}:${file.size}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const previewUrl = URL.createObjectURL(file);
        objectUrls.current.add(previewUrl);
        next.push({
          id: crypto.randomUUID(),
          source: "file",
          title: titleFromFilename(file.name),
          file,
          previewUrl,
          status: "ready",
        });
      }
      added = next.length;
      return next.length ? [...prev, ...next] : prev;
    });
    return added;
  }, []);

  const addUrlText = useCallback((text: string): number => {
    const urls = parseUrls(text);
    if (urls.length === 0) return 0;
    let added = 0;
    setItems((prev) => {
      const seen = new Set(prev.flatMap((item) => (item.url ? [item.url] : [])));
      const next: ImportItem[] = [];
      for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        next.push({
          id: crypto.randomUUID(),
          source: "url",
          title: titleFromUrl(url),
          url,
          previewUrl: url,
          status: "ready",
        });
      }
      added = next.length;
      return next.length ? [...prev, ...next] : prev;
    });
    return added;
  }, []);

  /** Routes a clipboard/drop payload: image files queue, URL text queues. */
  const addFromDataTransfer = useCallback(
    (data: DataTransfer): number => {
      let count = addFiles(data.files);
      const text = data.getData("text");
      if (text) count += addUrlText(text);
      return count;
    },
    [addFiles, addUrlText],
  );

  const updateTitle = useCallback((id: string, title: string) => patch(id, { title }), [patch]);

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.file && objectUrls.current.has(target.previewUrl)) {
        URL.revokeObjectURL(target.previewUrl);
        objectUrls.current.delete(target.previewUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current.clear();
    setItems([]);
    setProgress(null);
  }, []);

  const runImport = useCallback(async (): Promise<ImportResult> => {
    const pending = itemsRef.current.filter((item) => item.status !== "done");
    if (pending.length === 0) {
      return { importedArtworkIds: [], imported: 0, failed: 0 };
    }

    setIsImporting(true);
    setProgress({ done: 0, total: pending.length });
    const importedArtworkIds: string[] = [];
    let failed = 0;
    const advance = (by: number) =>
      setProgress((prev) => (prev ? { done: prev.done + by, total: prev.total } : prev));

    const fileItems = pending.filter((item) => item.source === "file");
    const urlItems = pending.flatMap((item) =>
      item.source === "url" && item.url ? [{ id: item.id, url: item.url, title: item.title }] : [],
    );

    const postUpload = async (group: ImportItem[]) => {
      const body = new FormData();
      for (const item of group) {
        if (item.file) {
          body.append("files", item.file, item.file.name);
          body.append("titles", item.title);
        }
      }
      const response = await fetch(`${env.VITE_SERVER_URL}/media/upload`, {
        method: "POST",
        body,
        credentials: "include",
      });
      const parsed = uploadResponse.safeParse(await response.json().catch(() => null));
      const payload = parsed.success ? parsed.data : null;
      if (!response.ok) {
        return { ok: false as const, message: payload?.error ?? "Upload failed" };
      }
      return { ok: true as const, uploaded: payload?.uploaded ?? [] };
    };

    // Uploads a group of files; on a batch failure or a result-count
    // mismatch, retries each file on its own so one bad file can't sink the
    // rest of the batch (mirroring the resilient per-URL path below).
    const uploadGroup = async (group: ImportItem[]): Promise<void> => {
      for (const item of group) patch(item.id, { status: "uploading", error: undefined });

      let result: Awaited<ReturnType<typeof postUpload>>;
      try {
        result = await postUpload(group);
      } catch (error) {
        result = {
          ok: false as const,
          message: error instanceof Error ? error.message : "Upload failed",
        };
      }

      if (result.ok && result.uploaded.length === group.length) {
        group.forEach((item, index) => {
          const artworkId = result.ok ? result.uploaded[index]?.artworkId : undefined;
          if (artworkId) {
            importedArtworkIds.push(artworkId);
            patch(item.id, { status: "done", artworkId });
          } else {
            failed += 1;
            patch(item.id, { status: "error", error: "No result returned" });
          }
        });
        advance(group.length);
        return;
      }

      if (group.length === 1) {
        const item = group[0];
        if (item) {
          failed += 1;
          patch(item.id, {
            status: "error",
            error: result.ok ? "No result returned" : result.message,
          });
        }
        advance(1);
        return;
      }

      for (const item of group) {
        await uploadGroup([item]);
      }
    };

    // finally so an unexpected throw can't leave `isImporting` stuck on.
    try {
      // Files: server-sized batches, falling back to single requests on failure.
      for (const group of chunk(fileItems, MAX_PER_REQUEST)) {
        await uploadGroup(group);
      }

      // URLs: one request each so a single dead link only fails itself.
      await runPool(urlItems, URL_CONCURRENCY, async (item) => {
        patch(item.id, { status: "uploading", error: undefined });
        try {
          const result = await importFromUrl.mutateAsync({
            items: [{ url: item.url, title: item.title || undefined }],
          });
          const artworkId = result.imported[0]?.artworkId;
          if (artworkId) {
            importedArtworkIds.push(artworkId);
            patch(item.id, { status: "done", artworkId });
          } else {
            failed += 1;
            patch(item.id, { status: "error", error: "Nothing imported" });
          }
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : "Could not import URL";
          patch(item.id, { status: "error", error: message });
        }
        advance(1);
      });
    } finally {
      setIsImporting(false);
    }

    return {
      importedArtworkIds,
      imported: importedArtworkIds.length,
      failed,
    };
  }, [importFromUrl, patch]);

  const counts = useMemo(() => {
    let ready = 0;
    let done = 0;
    let error = 0;
    for (const item of items) {
      if (item.status === "ready") ready += 1;
      else if (item.status === "done") done += 1;
      else if (item.status === "error") error += 1;
    }
    return { ready, done, error, total: items.length };
  }, [items]);

  return {
    items,
    counts,
    isImporting,
    progress,
    addFiles,
    addUrlText,
    addFromDataTransfer,
    updateTitle,
    remove,
    clear,
    runImport,
  };
}
