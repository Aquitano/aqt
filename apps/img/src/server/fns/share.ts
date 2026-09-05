import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import * as albumsService from "@/server/albums";
import { requireUser } from "@/server/auth";

const albumIdInput = type({ albumId: "string" });

export const enable = createServerFn({ method: "POST" })
  .validator(albumIdInput)
  .handler(async ({ data }) => ({
    slug: await albumsService.enableShare(data.albumId, await requireUser()),
  }));

export const disable = createServerFn({ method: "POST" })
  .validator(albumIdInput)
  .handler(async ({ data }) => {
    await albumsService.disableShare(data.albumId, await requireUser());
    return { ok: true } as const;
  });
