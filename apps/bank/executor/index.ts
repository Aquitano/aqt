import { defineApp, router, withApprovals } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import { always } from "apps/operations/approval";

import { bank, origin } from "./provider.js";

const instructions = `bank holds the owner's archive and, below /v1/disk, the catalogue of every file on the owner's disks, attached or not. The catalogue keeps no file bytes.

- Find files with disk.searchDisks, or search the archive and the disks together with search.search. Entries, archive members, document text, tags and OCR come back as separate lists, each ranked on its own scale.
- A place is missing when the last scan no longer found it, and has version "previous" when the file held this content before it changed.
- Cite a file by its content ref, content:<hex>, as the API returns it. Entry IDs only name a location in this catalogue.
- The server cannot read a disk. To get a file's bytes, ask the owner to run bank disk get on the machine the disk attaches to.
- AmbiguousRef lists candidates; retry with one candidate's longer ref.`;

const requirements = { app: { accounts: { bank } } };

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
        account: app.accounts.bank,
      }),
      (tool) => (tool.kind === "mutation" ? always() : undefined),
    ),
    {
      title: "bank",
      description: "Search the owner's archive and the catalogue of files on disks.",
      instructions,
    },
  ),
}));
