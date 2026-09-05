import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import * as apiKeysService from "@/server/api-keys";
import { requireUser } from "@/server/auth";

export const list = createServerFn({ method: "GET" }).handler(async () =>
  apiKeysService.listApiKeys(await requireUser()),
);

export const create = createServerFn({ method: "POST" })
  .validator(type({ name: "string > 0" }))
  .handler(async ({ data }) => apiKeysService.createApiKey(await requireUser(), data.name));

export const revoke = createServerFn({ method: "POST" })
  .validator(type({ id: "string" }))
  .handler(async ({ data }) => {
    await apiKeysService.revokeApiKey(data.id, await requireUser());
    return { ok: true } as const;
  });
