import { auth } from '@clerk/tanstack-react-start/server'
import { getRequestHeader } from '@tanstack/react-start/server'
import { userIdForApiKey } from '@/server/api-keys'

/**
 * User id for the current request, or null when signed out. Browsers carry a
 * Clerk session; the CLI and other machines send an API key as a bearer token.
 */
export async function currentUserId() {
  const bearer = getRequestHeader('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (bearer) return userIdForApiKey(bearer)
  const { userId } = await auth()
  return userId
}

/** Guard for server functions: returns the user id or throws a 401. */
export async function requireUser() {
  const userId = await currentUserId()
  if (!userId) throw new Response('Unauthorized', { status: 401 })
  return userId
}
