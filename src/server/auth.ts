import { auth } from '@clerk/tanstack-react-start/server'

/** Clerk user id for the current request, or null when signed out. */
export async function currentUserId() {
  const { userId } = await auth()
  return userId
}

/** Guard for server functions: returns the Clerk user id or throws a 401. */
export async function requireUser() {
  const userId = await currentUserId()
  if (!userId) throw new Response('Unauthorized', { status: 401 })
  return userId
}
