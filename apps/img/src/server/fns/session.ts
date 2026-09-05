import { createServerFn } from "@tanstack/react-start";
import { currentUserId } from "@/server/auth";

/** Route guards read the session through this rather than the Clerk client. */
export const getUserId = createServerFn({ method: "GET" }).handler(() => currentUserId());
