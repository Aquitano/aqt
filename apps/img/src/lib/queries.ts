import { queryOptions } from "@tanstack/react-query";

import { rejectFailures } from "@/lib/server-error";
import * as albumFns from "@/server/fns/albums";
import * as apiKeyFns from "@/server/fns/api-keys";
import * as photoFns from "@/server/fns/photos";

export const albumsQuery = () =>
  queryOptions({
    queryKey: ["albums"] as const,
    queryFn: () => rejectFailures(albumFns.list()),
  });

export const albumQuery = (albumId: string) =>
  queryOptions({
    queryKey: ["albums", albumId] as const,
    queryFn: () => rejectFailures(albumFns.get({ data: { albumId } })),
  });

export const sharedAlbumQuery = (slug: string) =>
  queryOptions({
    queryKey: ["shared", slug] as const,
    queryFn: () => rejectFailures(albumFns.getShared({ data: { slug } })),
  });

export const photosQuery = () =>
  queryOptions({
    queryKey: ["photos"] as const,
    queryFn: () => rejectFailures(photoFns.list()),
  });

export const apiKeysQuery = () =>
  queryOptions({
    queryKey: ["api-keys"] as const,
    queryFn: () => rejectFailures(apiKeyFns.list()),
  });
