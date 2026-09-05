export class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

/**
 * A `throw new Response(...)` in a server fn does not reject on the client: the
 * raw Response arrives as the resolved value. Turn a failed one into a real
 * rejection carrying the server's own wording.
 */
export async function rejectFailures<T>(work: Promise<T>): Promise<T> {
  const result = await work;
  if (result instanceof Response && !result.ok) {
    throw new ServerError(result.status, (await result.text()) || result.statusText);
  }
  return result;
}
