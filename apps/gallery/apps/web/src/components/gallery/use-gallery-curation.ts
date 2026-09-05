import type { AppRouter } from "@aqt/gallery-server/api/routers/index";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { ThemeValue } from "@/components/museum/theme";
import { useTRPC } from "@/utils/trpc";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type GalleryGroup = RouterOutputs["museum"]["myGroups"][number];
export type ArchiveArtwork = RouterOutputs["artworks"]["list"][number];

export type GalleryDetails = {
  name: string;
  tagline: string;
  description: string;
};

/**
 * The studio's curation engine, behind one interface. Owns the optimistic
 * membership order and the single `setGroupArtworks` reconcile, the bulk-add
 * selection, and every group-level mutation. The view crosses this seam for
 * data; it keeps only its own drag DOM state and form inputs.
 *
 * `members` reflects the optimistic order the instant a move/add/remove
 * happens; it reverts to the server's order once the sync settles or fails.
 */
export type GalleryCuration = {
  /** The loaded gallery, or null if it isn't (yet) in the caller's set. */
  group: GalleryGroup | null;
  /** True once the gallery list has resolved — lets the view show "not found". */
  loaded: boolean;
  /** True once the archive list has resolved. */
  archiveLoaded: boolean;
  /** Ordered artworks currently hung in the gallery. */
  members: ArchiveArtwork[];
  /** Archive artworks not yet hung — the add picker's source. */
  available: ArchiveArtwork[];
  /** Staged bulk-add selection (ids from `available`). */
  selected: Set<string>;
  /** A write is in flight; the view disables controls. */
  busy: boolean;
  toggleSelected: (id: string) => void;
  clearSelected: () => void;
  addSelected: () => void;
  /** Append archive artworks (by id) to the gallery — used by import. Stable. */
  addArtworks: (artworkIds: string[]) => void;
  move: (sourceId: string, targetId: string) => void;
  remove: (id: string) => void;
  setCover: (artworkId: string | null) => Promise<void>;
  saveTheme: (theme: ThemeValue) => Promise<void>;
  saveDetails: (details: GalleryDetails) => Promise<void>;
  togglePublish: () => Promise<void>;
  deleteGroup: () => Promise<void>;
};

export function useGalleryCuration(galleryId: string): GalleryCuration {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const myGroups = useQuery(trpc.museum.myGroups.queryOptions());
  const archive = useQuery(trpc.artworks.list.queryOptions({}));

  const updateGroup = useMutation(trpc.museum.updateGroup.mutationOptions());
  const deleteGroupMut = useMutation(trpc.museum.deleteGroup.mutationOptions());
  const setGroupArtworks = useMutation(trpc.museum.setGroupArtworks.mutationOptions());

  const group = (myGroups.data ?? []).find((g) => g.id === galleryId) ?? null;

  // Optimistic membership order; null means "use the server's order".
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Drop optimistic state whenever the loaded gallery changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on gallery switch
  useEffect(() => {
    setPendingOrder(null);
    setSelected(new Set());
  }, [group?.id]);

  const refresh = () => queryClient.invalidateQueries();

  const memberIds = pendingOrder ?? group?.artworkIds ?? [];
  const archiveById = useMemo(
    () => new Map((archive.data ?? []).map((a) => [a.id, a])),
    [archive.data],
  );
  const members = memberIds
    .map((id) => archiveById.get(id))
    .filter((a): a is ArchiveArtwork => a !== undefined);
  const available = (archive.data ?? []).filter((a) => !memberIds.includes(a.id));

  const busy = setGroupArtworks.isPending || updateGroup.isPending || deleteGroupMut.isPending;

  // The one sync point: replace the gallery's artworks with `artworkIds`,
  // holding them on screen optimistically until the server confirms.
  const syncArtworks = async (artworkIds: string[]) => {
    if (!group) return;
    setPendingOrder(artworkIds);
    try {
      await setGroupArtworks.mutateAsync({ groupId: group.id, artworkIds });
      await refresh();
    } catch {
      // The global mutation error handler surfaces the toast; here we only
      // need to drop the optimistic order so the UI reverts.
    } finally {
      setPendingOrder(null);
    }
  };

  const move = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const ids = [...memberIds];
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    void syncArtworks(ids);
  };

  const remove = (id: string) => {
    void syncArtworks(memberIds.filter((memberId) => memberId !== id));
  };

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const clearSelected = () => setSelected(new Set());

  const addSelected = () => {
    const toAdd = available.filter((a) => selected.has(a.id)).map((a) => a.id);
    if (toAdd.length === 0) return;
    setSelected(new Set());
    void syncArtworks([...memberIds, ...toAdd]);
  };

  // Refs let `addArtworks` stay referentially stable (so the import provider
  // can register it once) while still acting on the latest membership.
  const memberIdsRef = useRef(memberIds);
  memberIdsRef.current = memberIds;
  const hasGroupRef = useRef(group !== null);
  hasGroupRef.current = group !== null;
  const syncArtworksRef = useRef(syncArtworks);
  syncArtworksRef.current = syncArtworks;

  const addArtworks = useCallback((artworkIds: string[]) => {
    if (!hasGroupRef.current || artworkIds.length === 0) return;
    const current = memberIdsRef.current;
    const fresh = artworkIds.filter((id) => !current.includes(id));
    if (fresh.length === 0) return;
    void syncArtworksRef.current([...current, ...fresh]);
  }, []);

  const setCover = async (artworkId: string | null) => {
    if (!group) return;
    await updateGroup.mutateAsync({ id: group.id, coverArtworkId: artworkId });
    await refresh();
    toast.success(artworkId ? "Cover updated" : "Cover reset");
  };

  const saveTheme = async (theme: ThemeValue) => {
    if (!group) return;
    await updateGroup.mutateAsync({ id: group.id, theme });
    await refresh();
    toast.success("Theme saved");
  };

  const saveDetails = async (details: GalleryDetails) => {
    if (!group) return;
    await updateGroup.mutateAsync({
      id: group.id,
      name: details.name.trim(),
      tagline: details.tagline.trim() || null,
      description: details.description.trim() || null,
    });
    await refresh();
    toast.success("Details saved");
  };

  const togglePublish = async () => {
    if (!group) return;
    await updateGroup.mutateAsync({
      id: group.id,
      isPublished: !group.isPublished,
    });
    await refresh();
  };

  const deleteGroup = async () => {
    if (!group) return;
    await deleteGroupMut.mutateAsync({ id: group.id });
    await refresh();
    toast.success("Gallery deleted");
  };

  return {
    group,
    loaded: myGroups.isSuccess,
    archiveLoaded: !archive.isPending,
    members,
    available,
    selected,
    busy,
    toggleSelected,
    clearSelected,
    addSelected,
    addArtworks,
    move,
    remove,
    setCover,
    saveTheme,
    saveDetails,
    togglePublish,
    deleteGroup,
  };
}
