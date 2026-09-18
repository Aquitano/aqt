import type { AppRouter } from "@aqt/gallery-server/api/routers/index";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type { ThemeValue } from "@/components/museum/theme";
import type { CuratedKind } from "@/components/museum/types";
import { useTRPC } from "@/utils/trpc";

import { reorder } from "./reorder";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type StudioExhibition = RouterOutputs["exhibitions"]["mine"][number];
export type StudioRoom = StudioExhibition["rooms"][number];
export type ArchiveArtwork = RouterOutputs["artworks"]["list"][number];
export type LintReport = RouterOutputs["exhibitions"]["lint"];
export type RoomLintFinding = LintReport["findings"][number];

/** One member's curated wall placement, as the studio holds it. Wall type is
 * whatever the server reports (mirrors `@aqt/gallery-layout`'s WallId). */
export type PlacementDetail = Pick<
  StudioRoom["placements"][number],
  "wall" | "wallOffset" | "scale"
>;
export type PlacementPatch = Partial<PlacementDetail>;

export type ExhibitionDetails = {
  name: string;
  tagline: string;
  description: string;
  kind: CuratedKind;
};

export type CuratedExhibition = StudioExhibition & { kind: CuratedKind };

export function isCurated(e: StudioExhibition): e is CuratedExhibition {
  return e.kind !== "personal";
}

/** A room with its membership resolved to full artworks, in order. */
export type RoomView = {
  id: string;
  name: string;
  description: string | null;
  layout: StudioRoom["layout"];
  members: ArchiveArtwork[];
  /** Curated wall placement per member id (optimistic where a save is live). */
  placementById: Map<string, PlacementDetail>;
  /** Room-scoped lint findings (e.g. an over-packed wall) to warn the curator
   * as they hang, without pulling in the exhibition-wide lint panel. */
  warnings: RoomLintFinding[];
};

/**
 * The studio's curation engine, behind one interface. Owns the per-room
 * optimistic order and the per-room `setRoomArtworks` reconcile, plus every
 * exhibition- and room-level mutation. Membership is unique exhibition-wide:
 * an artwork hangs in at most one room, so `available` is the hangable pool
 * (own works plus anyone's published ones) minus everything already placed
 * anywhere in the exhibition.
 */
export type ExhibitionCuration = {
  exhibition: CuratedExhibition | null;
  loaded: boolean;
  archiveLoaded: boolean;
  /** Rooms with resolved, ordered members (optimistic where a sync is live). */
  rooms: RoomView[];
  /** Hangable artworks not hung in any room of this exhibition. */
  available: ArchiveArtwork[];
  busy: boolean;
  /** Latest pre-publish lint report, or null before it first resolves. */
  lint: LintReport | null;
  /** The lint query is fetching (initial load or a post-mutation refetch). */
  lintLoading: boolean;
  saveDetails: (details: ExhibitionDetails) => Promise<void>;
  saveTheme: (theme: ThemeValue) => Promise<void>;
  setCover: (artworkId: string | null) => Promise<void>;
  togglePublish: () => Promise<void>;
  deleteExhibition: () => Promise<void>;
  addRoom: (name: string) => Promise<{ id: string } | undefined>;
  renameRoom: (roomId: string, details: { name: string; description: string }) => Promise<void>;
  deleteRoom: (roomId: string) => Promise<void>;
  moveRoom: (roomId: string, direction: "up" | "down") => void;
  addToRoom: (roomId: string, artworkIds: string[]) => void;
  removeFromRoom: (roomId: string, artworkId: string) => void;
  moveInRoom: (roomId: string, sourceId: string, targetId: string) => void;
  /** Patch one member's curated wall placement (optimistic, then persisted). */
  setPlacement: (roomId: string, artworkId: string, patch: PlacementPatch) => void;
};

export function useExhibitionCuration(exhibitionId: string): ExhibitionCuration {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const mine = useQuery(trpc.exhibitions.mine.queryOptions());
  const archive = useQuery(trpc.artworks.list.queryOptions({ scope: "all" }));

  const updateMut = useMutation(trpc.exhibitions.update.mutationOptions());
  const deleteMut = useMutation(trpc.exhibitions.delete.mutationOptions());
  const createRoomMut = useMutation(trpc.exhibitions.createRoom.mutationOptions());
  const updateRoomMut = useMutation(trpc.exhibitions.updateRoom.mutationOptions());
  const deleteRoomMut = useMutation(trpc.exhibitions.deleteRoom.mutationOptions());
  const reorderRoomsMut = useMutation(trpc.exhibitions.reorderRooms.mutationOptions());
  const setRoomArtworksMut = useMutation(trpc.exhibitions.setRoomArtworks.mutationOptions());
  const setRoomPlacementsMut = useMutation(trpc.exhibitions.setRoomPlacements.mutationOptions());

  const exhibition = (mine.data ?? []).filter(isCurated).find((e) => e.id === exhibitionId) ?? null;

  // Owner-only pre-publish check; kept lazy until the exhibition resolves so a
  // not-found id never fires a failing lint request. `refresh()` below
  // invalidates the whole `exhibitions` path, so it refetches after any
  // curation write. Feeds both the lint panel and the per-room `warnings`.
  const lint = useQuery({
    ...trpc.exhibitions.lint.queryOptions({ exhibitionId }),
    enabled: exhibition !== null,
    // Advisory only: a lint failure degrades to no warnings, so keep it out of
    // the global error toast.
    meta: { suppressErrorToast: true },
  });
  // Optimistic membership order, keyed by room id; absent means "use server".
  const [pendingOrders, setPendingOrders] = useState<Record<string, string[]>>({});
  // Optimistic placement patches, keyed by `${roomId}:${artworkId}`, merged over
  // the server values until the save settles.
  const [pendingPlacements, setPendingPlacements] = useState<Record<string, PlacementPatch>>({});

  // Drop optimistic state only on exhibition switch
  useEffect(() => {
    setPendingOrders({});
    setPendingPlacements({});
  }, [exhibition?.id]);

  // Scope invalidation to the routers a curation write can affect rather than
  // every query in the app, so repeated room edits don't refetch the world.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.exhibitions.pathFilter()),
      queryClient.invalidateQueries(trpc.artworks.pathFilter()),
    ]);

  const archiveById = useMemo(
    () => new Map((archive.data ?? []).map((a) => [a.id, a])),
    [archive.data],
  );

  const roomIdsOf = (room: StudioRoom) =>
    pendingOrders[room.id] ?? room.placements.map((p) => p.artworkId);

  const placementMapOf = (room: StudioRoom): Map<string, PlacementDetail> => {
    const map = new Map<string, PlacementDetail>(
      room.placements.map((p) => [
        p.artworkId,
        { wall: p.wall, wallOffset: p.wallOffset, scale: p.scale },
      ]),
    );
    for (const artworkId of roomIdsOf(room)) {
      const override = pendingPlacements[`${room.id}:${artworkId}`];
      const base = map.get(artworkId) ?? {
        wall: null,
        wallOffset: null,
        scale: null,
      };
      map.set(artworkId, override ? { ...base, ...override } : base);
    }
    return map;
  };

  // Group the lint's room-scoped findings by room. The empty-room notice is
  // already shown inline by the panel, and exhibition-wide aggregate findings
  // (missing dimensions, etc.) are left for the lint panel.
  const warningsByRoom = new Map<string, RoomLintFinding[]>();
  for (const finding of lint.data?.findings ?? []) {
    if (!finding.roomId || finding.code === "empty_room") continue;
    if (finding.level !== "warning" && finding.level !== "error") continue;
    const list = warningsByRoom.get(finding.roomId) ?? [];
    list.push(finding);
    warningsByRoom.set(finding.roomId, list);
  }

  const rooms: RoomView[] = (exhibition?.rooms ?? []).map((room) => ({
    id: room.id,
    name: room.name,
    description: room.description,
    layout: room.layout,
    members: roomIdsOf(room)
      .map((id) => archiveById.get(id))
      .filter((a): a is ArchiveArtwork => a !== undefined),
    placementById: placementMapOf(room),
    warnings: warningsByRoom.get(room.id) ?? [],
  }));

  const placedIds = new Set((exhibition?.rooms ?? []).flatMap((room) => roomIdsOf(room)));
  const available = (archive.data ?? []).filter((a) => !placedIds.has(a.id));

  const busy =
    updateMut.isPending ||
    deleteMut.isPending ||
    createRoomMut.isPending ||
    updateRoomMut.isPending ||
    deleteRoomMut.isPending ||
    reorderRoomsMut.isPending ||
    setRoomArtworksMut.isPending;

  // The per-room sync point: replace a room's artworks with `artworkIds`,
  // holding them on screen optimistically until the server confirms.
  const syncRoom = async (roomId: string, artworkIds: string[]) => {
    setPendingOrders((prev) => ({ ...prev, [roomId]: artworkIds }));
    try {
      await setRoomArtworksMut.mutateAsync({ roomId, artworkIds });
      await refresh();
    } catch {
      // The global mutation error handler surfaces the toast; we only need
      // to drop the optimistic order so the UI reverts.
    } finally {
      setPendingOrders((prev) => {
        const next = { ...prev };
        delete next[roomId];
        return next;
      });
    }
  };

  const currentRoomIds = (roomId: string): string[] => {
    const room = exhibition?.rooms.find((r) => r.id === roomId);
    if (!room) return [];
    return roomIdsOf(room);
  };

  const addToRoom = (roomId: string, artworkIds: string[]) => {
    const current = currentRoomIds(roomId);
    const fresh = artworkIds.filter((id) => !current.includes(id));
    if (fresh.length === 0) return;
    void syncRoom(roomId, [...current, ...fresh]);
  };

  const removeFromRoom = (roomId: string, artworkId: string) => {
    void syncRoom(
      roomId,
      currentRoomIds(roomId).filter((id) => id !== artworkId),
    );
  };

  const moveInRoom = (roomId: string, sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const ids = currentRoomIds(roomId);
    if (!ids.includes(sourceId) || !ids.includes(targetId)) return;
    void syncRoom(roomId, reorder(ids, sourceId, targetId));
  };

  const setPlacement = (roomId: string, artworkId: string, patch: PlacementPatch) => {
    const key = `${roomId}:${artworkId}`;
    setPendingPlacements((prev) => ({
      ...prev,
      [key]: { ...prev[key], ...patch },
    }));
    void (async () => {
      try {
        await setRoomPlacementsMut.mutateAsync({
          roomId,
          placements: [{ artworkId, ...patch }],
        });
        await refresh();
      } catch {
        // The global mutation error handler toasts; dropping the override in
        // `finally` reverts the board to the server's placement.
      } finally {
        setPendingPlacements((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    })();
  };

  const saveDetails = async (details: ExhibitionDetails) => {
    if (!exhibition) return;
    await updateMut.mutateAsync({
      exhibitionId: exhibition.id,
      name: details.name.trim(),
      tagline: details.tagline.trim() || null,
      description: details.description.trim() || null,
      kind: details.kind,
    });
    await refresh();
    toast.success("Details saved");
  };

  const saveTheme = async (theme: ThemeValue) => {
    if (!exhibition) return;
    await updateMut.mutateAsync({ exhibitionId: exhibition.id, theme });
    await refresh();
    toast.success("Theme saved");
  };

  const setCover = async (artworkId: string | null) => {
    if (!exhibition) return;
    await updateMut.mutateAsync({
      exhibitionId: exhibition.id,
      coverArtworkId: artworkId,
    });
    await refresh();
    toast.success(artworkId ? "Cover updated" : "Cover reset");
  };

  const togglePublish = async () => {
    if (!exhibition) return;
    await updateMut.mutateAsync({
      exhibitionId: exhibition.id,
      isPublished: !exhibition.isPublished,
    });
    await refresh();
  };

  const deleteExhibition = async () => {
    if (!exhibition) return;
    await deleteMut.mutateAsync({ exhibitionId: exhibition.id });
    await refresh();
    toast.success("Exhibition deleted");
  };

  const addRoom = async (name: string) => {
    if (!exhibition) return undefined;
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    const created = await createRoomMut.mutateAsync({
      exhibitionId: exhibition.id,
      name: trimmed,
    });
    await refresh();
    toast.success("Room added");
    return created;
  };

  const renameRoom = async (roomId: string, details: { name: string; description: string }) => {
    await updateRoomMut.mutateAsync({
      roomId,
      name: details.name.trim(),
      description: details.description.trim() || null,
    });
    await refresh();
    toast.success("Room saved");
  };

  const deleteRoom = async (roomId: string) => {
    await deleteRoomMut.mutateAsync({ roomId });
    await refresh();
    toast.success("Room deleted");
  };

  const moveRoom = (roomId: string, direction: "up" | "down") => {
    if (!exhibition) return;
    const ids = exhibition.rooms.map((r) => r.id);
    const index = ids.indexOf(roomId);
    if (index === -1) return;
    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= ids.length) return;
    [ids[index], ids[swapWith]] = [ids[swapWith] as string, ids[index] as string];
    void (async () => {
      await reorderRoomsMut.mutateAsync({
        exhibitionId: exhibition.id,
        roomIds: ids,
      });
      await refresh();
    })();
  };

  return {
    exhibition,
    loaded: mine.isSuccess,
    archiveLoaded: !archive.isPending,
    rooms,
    available,
    busy,
    lint: lint.data ?? null,
    lintLoading: lint.isFetching,
    saveDetails,
    saveTheme,
    setCover,
    togglePublish,
    deleteExhibition,
    addRoom,
    renameRoom,
    deleteRoom,
    moveRoom,
    addToRoom,
    removeFromRoom,
    moveInRoom,
    setPlacement,
  };
}
