import { defineApp, router, withApprovals } from "apps";
import { always } from "apps/operations/approval";
import { liveOpenapiRouter } from "apps/openapi";

import { attic, origin } from "./provider.js";

const instructions = `attic catalogues every file on the owner's disks, attached or not, and keeps no file bytes.

- Find files with catalogue.search. Entries, archive members, document text, tags and OCR come back as separate lists, each ranked on its own scale.
- A place is online when its disk is attached now, missing when the last scan no longer found it, and version "previous" when the file held this content before it changed.
- Cite a file as attic:<ref>. Entry IDs only name a location in this catalogue.
- contents.downloadContent returns the bytes from an attached disk. Unavailable means no copy is attached: tell the owner which of the error's volumes to connect.
- AmbiguousRef lists candidates; retry with one candidate's longer ref.`;

const requirements = { app: { accounts: { attic } } };

export default defineApp(requirements, async ({ app, cache, fetch, signal }) => ({
  tools: router(
    withApprovals(
      liveOpenapiRouter({
        source: { url: `${origin}/openapi.json` },
        allowedOrigin: origin,
        baseUrl: origin,
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
        methods: { token: [{ scheme: "bearer", field: "token", part: "value", prefix: "" }] },
        oauth: [],
        cache,
        fetch,
        signal,
        account: app.accounts.attic,
      }),
      (tool) => (tool.kind === "mutation" ? always() : undefined),
    ),
    {
      title: "attic",
      description: "Search the owner's file catalogue and fetch files from attached disks.",
      instructions,
    },
  ),
}));
