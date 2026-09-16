import { env } from "@aqt/gallery-env/web";
import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => ({
  requestMiddleware: [clerkMiddleware({ publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY })],
}));
