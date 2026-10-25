import { decodeJson, defineProvider, number, object, secrets, string } from "apps";

// Where attic serve listens. The token is only ever sent to this host.
export const origin = "http://127.0.0.1:8490";

export const attic = defineProvider({
  name: "attic",
  hosts: [new URL(origin).host],
  auth: {
    token: secrets({
      label: "attic API token",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
  },
  async health({ account, fetch, signal }) {
    const response = await fetch(`${origin}/v1/stats`, {
      signal,
      headers: { Authorization: `Bearer ${account.fields.token}` },
    });
    const stats = await decodeJson(response, object({ volumes: number(), files: number() }));
    return {
      accountInfo: { displayName: `attic: ${stats.files} files on ${stats.volumes} volumes` },
    };
  },
});
