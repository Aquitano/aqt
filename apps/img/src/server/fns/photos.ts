import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";

import { requireUser } from "@/server/auth";
import * as photosService from "@/server/photos";

export const list = createServerFn({ method: "GET" }).handler(async () =>
  photosService.listPhotos(await requireUser()),
);

/** Reserves a row and its R2 keys; the client then PUTs both files. */
export const create = createServerFn({ method: "POST" })
  .validator(type({ width: "number.integer > 0", height: "number.integer > 0" }))
  .handler(async ({ data }) => photosService.createPhoto(await requireUser(), data));

export const remove = createServerFn({ method: "POST" })
  .validator(type({ photoId: "string" }))
  .handler(async ({ data }) => {
    await photosService.deletePhoto(data.photoId, await requireUser());
    return { ok: true } as const;
  });
