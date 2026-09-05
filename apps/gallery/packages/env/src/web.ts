import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/** The two variables Vite inlines into the client bundle. Declared here so
 * they stay typed without `vite/client`, whose types this package does not
 * pull in; the declaration merges with the web app's. */
declare global {
  interface ImportMetaEnv {
    readonly VITE_SERVER_URL?: string;
    readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  }
}

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_SERVER_URL: z.url(),
    VITE_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  },
  runtimeEnvStrict: {
    VITE_SERVER_URL: import.meta.env.VITE_SERVER_URL,
    VITE_CLERK_PUBLISHABLE_KEY: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
  },
  emptyStringAsUndefined: true,
});
