import { type, type Type } from "arktype";
import { albumInput, albumPatch, bookInput, photoInput } from "@/domain/api";
import * as albums from "@/server/albums";
import { currentUserId } from "@/server/auth";
import * as photos from "@/server/photos";
import * as spreads from "@/server/spreads";

/**
 * The JSON API behind `/api/v1/*`, one splat route with its own tiny matcher.
 * Every endpoint needs a user (bearer key or Clerk session) and speaks JSON;
 * errors are `{ error }` with the matching status. Photo bytes go through
 * `PUT /api/photos/:id` as the browser does.
 */

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type Context = {
  userId: string;
  params: Record<string, string>;
  request: Request;
  origin: string;
};

type Route = {
  method: Method;
  segments: string[];
  handler: (ctx: Context) => Promise<Response>;
};

const routes: Route[] = [];

function on(method: Method, path: string, handler: Route["handler"]) {
  routes.push({ method, segments: path.split("/").filter(Boolean), handler });
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

const noContent = () => new Response(null, { status: 204 });

/** Parses and validates a JSON body; 400 with ArkType's summary otherwise. */
async function body<T extends Type>(request: Request, schema: T): Promise<T["infer"]> {
  const raw = await request.json().catch(() => {
    throw new Response("Body must be JSON", { status: 400 });
  });
  const result = schema(raw);
  if (result instanceof type.errors) throw new Response(result.summary, { status: 400 });
  return result as T["infer"];
}

on("GET", "/me", async ({ userId }) => json({ userId }));

on("GET", "/albums", async ({ userId }) => json(await albums.listAlbums(userId)));
on("POST", "/albums", async ({ userId, request }) =>
  json(await albums.createAlbum(userId, await body(request, albumInput)), 201),
);
on("GET", "/albums/:albumId", async ({ userId, params }) => {
  const book = await albums.getAlbum(params.albumId, userId);
  return book ? json(book) : json({ error: "Not found" }, 404);
});
on("PATCH", "/albums/:albumId", async ({ userId, params, request }) => {
  await albums.updateAlbum(params.albumId, userId, await body(request, albumPatch));
  return json(await albums.findOwnedAlbum(params.albumId, userId));
});
on("DELETE", "/albums/:albumId", async ({ userId, params }) => {
  await albums.deleteAlbum(params.albumId, userId);
  return noContent();
});

on("PUT", "/albums/:albumId/book", async ({ userId, params, request }) => {
  const { spreads: list, ...patch } = await body(request, bookInput);
  if (patch.title !== undefined || patch.cover !== undefined) {
    await albums.updateAlbum(params.albumId, userId, patch);
  }
  const rows = await spreads.replaceSpreads(params.albumId, userId, list);
  return json({ album: await albums.findOwnedAlbum(params.albumId, userId), spreads: rows });
});

on("POST", "/albums/:albumId/share", async ({ userId, params, origin }) => {
  const slug = await albums.enableShare(params.albumId, userId);
  return json({ slug, url: `${origin}/s/${slug}` });
});
on("DELETE", "/albums/:albumId/share", async ({ userId, params }) => {
  await albums.disableShare(params.albumId, userId);
  return noContent();
});

on("GET", "/photos", async ({ userId }) => json(await photos.listPhotos(userId)));
on("POST", "/photos", async ({ userId, request }) => {
  const photo = await photos.createPhoto(userId, await body(request, photoInput));
  return json(
    {
      ...photo,
      uploadUrl: `/api/photos/${photo.id}`,
      thumbUploadUrl: `/api/photos/${photo.id}?thumb=1`,
    },
    201,
  );
});
on("DELETE", "/photos/:photoId", async ({ userId, params }) => {
  await photos.deletePhoto(params.photoId, userId);
  return noContent();
});

function match(method: string, path: string) {
  const parts = path.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = route.segments.every((segment, i) => {
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = decodeURIComponent(parts[i]);
        return true;
      }
      return segment === parts[i];
    });
    if (ok) return { route, params };
  }
  return null;
}

/** Entry point for the splat route; `path` is everything after `/api/v1/`. */
export async function handleApi(request: Request, path: string) {
  const found = match(request.method, path);
  if (!found) return json({ error: "Not found" }, 404);
  const userId = await currentUserId();
  if (!userId) return json({ error: "Unauthorized" }, 401);
  try {
    return await found.route.handler({
      userId,
      params: found.params,
      request,
      origin: new URL(request.url).origin,
    });
  } catch (error) {
    if (error instanceof Response) {
      return json({ error: (await error.text()) || error.statusText }, error.status);
    }
    throw error;
  }
}
