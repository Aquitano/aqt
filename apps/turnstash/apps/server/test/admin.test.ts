import { expect, setDefaultTimeout, test } from "bun:test";

import { BunHttpClient, BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { AuthLive } from "../src/auth.ts";
import { ApiLive } from "../src/http.ts";
import { runTest, type TestServices } from "./support.ts";

setDefaultTimeout(30_000);

test("admin inputs holding a NUL character are rejected with 400", async () => {
  await runTest(
    Effect.gen(function* () {
      const services = yield* Effect.context<TestServices>();
      const web = HttpRouter.toWebHandler(
        ApiLive.pipe(
          Layer.provide(AuthLive),
          Layer.provideMerge(Layer.succeedContext(services)),
          Layer.provideMerge(BunHttpClient.layer),
          Layer.provide(BunHttpServer.layerHttpServices),
        ),
        { disableLogger: true },
      );
      const nul = "a\u0000b";
      const id = "11111111-1111-4111-8111-111111111111";
      const requests: ReadonlyArray<readonly [method: string, path: string, body?: unknown]> = [
        ["POST", "/tokens", { name: nul, scopes: ["read"] }],
        [
          "POST",
          "/plans",
          { provider: "claude", name: nul, monthlyPrice: 1, startedOn: "2026-01-01" },
        ],
        ["PATCH", `/plans/${id}`, { name: nul }],
        ["POST", `/plans/${id}/change`, { name: nul, monthlyPrice: 1, effectiveOn: "2026-02-01" }],
        ["PUT", "/pricing/rules", { model: nul, rule: { kind: "unpriced", reason: "free" } }],
        ["PUT", "/pricing/rules", { model: "proxy", rule: { kind: "alias", target: nul } }],
        ["DELETE", `/pricing/rules?model=${encodeURIComponent(nul)}`],
        ["POST", "/pricing/revalue", { catalogVersion: nul }],
        ["POST", "/enroll", { name: nul, os: "linux", arch: "x64", agentVersion: "1" }],
        [
          "POST",
          "/bookmarks",
          { conversationId: id, target: { kind: "message", messageKey: nul } },
        ],
      ];
      const statuses = yield* Effect.promise(() =>
        Promise.all(
          requests.map(async ([method, path, body]) => {
            const response = await web.handler(
              new Request(`http://turnstash.test/api${path}`, {
                method,
                headers: {
                  authorization: "Bearer admin-secret",
                  "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
            );
            return `${method} ${path.split("?")[0]} ${response.status}`;
          }),
        ),
      ).pipe(Effect.ensuring(Effect.promise(() => web.dispose())));
      expect(statuses).toEqual(
        requests.map(([method, path]) => `${method} ${path.split("?")[0]} 400`),
      );
    }),
  );
});
