import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";

import { elementList } from "@/domain/element";
import { requireUser } from "@/server/auth";
import * as spreadsService from "@/server/spreads";

export const insert = createServerFn({ method: "POST" })
  .validator(
    // The editor creates the id up front so its optimistic state matches the
    // row, and passes elements when it re-inserts a spread it had deleted.
    type({
      albumId: "string",
      afterPosition: "number.integer",
      "id?": "string",
      "elements?": elementList,
    }),
  )
  .handler(async ({ data }) => spreadsService.insertSpread(await requireUser(), data));

export const remove = createServerFn({ method: "POST" })
  .validator(type({ spreadId: "string" }))
  .handler(async ({ data }) => {
    await spreadsService.deleteSpread(data.spreadId, await requireUser());
    return { ok: true } as const;
  });

export const reorder = createServerFn({ method: "POST" })
  .validator(type({ albumId: "string", orderedIds: "string[]" }))
  .handler(async ({ data }) => {
    await spreadsService.reorderSpreads(data.albumId, await requireUser(), data.orderedIds);
    return { ok: true } as const;
  });

/** Autosave target. */
export const saveElements = createServerFn({ method: "POST" })
  .validator(type({ spreadId: "string", elements: elementList }))
  .handler(async ({ data }) => ({
    updatedAt: await spreadsService.saveElements(data.spreadId, await requireUser(), data.elements),
  }));
