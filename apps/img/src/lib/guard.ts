import { redirect } from "@tanstack/react-router";
import { getUserId } from "@/server/fns/session";

/** `beforeLoad` guard: sends signed-out visitors back to the landing page. */
export async function requireSignedIn() {
  const userId = await getUserId();
  if (!userId) throw redirect({ to: "/" });
}
