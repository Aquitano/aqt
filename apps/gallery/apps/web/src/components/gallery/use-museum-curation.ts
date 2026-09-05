import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useEffect, useMemo, useState } from "react";
import type { AppRouter } from "server/api/routers/index";
import { toast } from "sonner";

import type { ThemeValue } from "@/components/museum/theme";
import { useTRPC } from "@/utils/trpc";

import type { ArchiveArtwork } from "./use-gallery-curation";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type StudioMuseum = RouterOutputs["museum"]["myMuseums"][number];
export type StudioRoom = StudioMuseum["rooms"][number];
export type { ArchiveArtwork };

export type MuseumDetails = {
	name: string;
	tagline: string;
	description: string;
};

/** A room with its membership resolved to full archive artworks, in order. */
export type RoomView = {
	id: string;
	name: string;
	description: string | null;
	members: ArchiveArtwork[];
};

/**
 * The museum studio's curation engine, behind one interface — the multi-room
 * sibling of {@link useGalleryCuration}. Owns the per-room optimistic order and
 * the per-room `setRoomArtworks` reconcile, plus every museum- and room-level
 * mutation. Room membership is unique museum-wide in the UI: an artwork hangs
 * in at most one room, so `available` is the archive minus everything already
 * placed anywhere in the museum.
 */
export type MuseumCuration = {
	museum: StudioMuseum | null;
	loaded: boolean;
	archiveLoaded: boolean;
	/** Rooms with resolved, ordered members (optimistic where a sync is live). */
	rooms: RoomView[];
	/** Archive artworks not hung in any room of this museum. */
	available: ArchiveArtwork[];
	busy: boolean;
	saveDetails: (details: MuseumDetails) => Promise<void>;
	saveTheme: (theme: ThemeValue) => Promise<void>;
	setCover: (artworkId: string | null) => Promise<void>;
	togglePublish: () => Promise<void>;
	deleteMuseum: () => Promise<void>;
	addRoom: (name: string) => Promise<{ id: string } | undefined>;
	renameRoom: (
		roomId: string,
		details: { name: string; description: string },
	) => Promise<void>;
	deleteRoom: (roomId: string) => Promise<void>;
	moveRoom: (roomId: string, direction: "up" | "down") => void;
	addToRoom: (roomId: string, artworkIds: string[]) => void;
	removeFromRoom: (roomId: string, artworkId: string) => void;
	moveInRoom: (roomId: string, sourceId: string, targetId: string) => void;
};

export function useMuseumCuration(museumId: string): MuseumCuration {
	const trpc = useTRPC();
	const queryClient = useQueryClient();

	const myMuseums = useQuery(trpc.museum.myMuseums.queryOptions());
	const archive = useQuery(trpc.artworks.list.queryOptions({}));

	const updateMuseum = useMutation(trpc.museum.updateMuseum.mutationOptions());
	const deleteMuseumMut = useMutation(
		trpc.museum.deleteMuseum.mutationOptions(),
	);
	const createRoomMut = useMutation(trpc.museum.createRoom.mutationOptions());
	const updateRoomMut = useMutation(trpc.museum.updateRoom.mutationOptions());
	const deleteRoomMut = useMutation(trpc.museum.deleteRoom.mutationOptions());
	const reorderRoomsMut = useMutation(
		trpc.museum.reorderRooms.mutationOptions(),
	);
	const setRoomArtworksMut = useMutation(
		trpc.museum.setRoomArtworks.mutationOptions(),
	);

	const museum = (myMuseums.data ?? []).find((m) => m.id === museumId) ?? null;

	// Optimistic membership order, keyed by room id; absent means "use server".
	const [pendingOrders, setPendingOrders] = useState<Record<string, string[]>>(
		{},
	);

	// Drop optimistic state whenever the loaded museum changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on museum switch
	useEffect(() => {
		setPendingOrders({});
	}, [museum?.id]);

	const refresh = () => queryClient.invalidateQueries();

	const archiveById = useMemo(
		() => new Map((archive.data ?? []).map((a) => [a.id, a])),
		[archive.data],
	);

	const roomIdsOf = (room: StudioRoom) =>
		pendingOrders[room.id] ?? room.artworkIds;

	const rooms: RoomView[] = (museum?.rooms ?? []).map((room) => ({
		id: room.id,
		name: room.name,
		description: room.description,
		members: roomIdsOf(room)
			.map((id) => archiveById.get(id))
			.filter((a): a is ArchiveArtwork => a !== undefined),
	}));

	const placedIds = new Set(
		(museum?.rooms ?? []).flatMap((room) => roomIdsOf(room)),
	);
	const available = (archive.data ?? []).filter((a) => !placedIds.has(a.id));

	const busy =
		updateMuseum.isPending ||
		deleteMuseumMut.isPending ||
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
		const room = museum?.rooms.find((r) => r.id === roomId);
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
		const ids = [...currentRoomIds(roomId)];
		const from = ids.indexOf(sourceId);
		const to = ids.indexOf(targetId);
		if (from === -1 || to === -1) return;
		ids.splice(from, 1);
		ids.splice(to, 0, sourceId);
		void syncRoom(roomId, ids);
	};

	const saveDetails = async (details: MuseumDetails) => {
		if (!museum) return;
		await updateMuseum.mutateAsync({
			id: museum.id,
			name: details.name.trim(),
			tagline: details.tagline.trim() || null,
			description: details.description.trim() || null,
		});
		await refresh();
		toast.success("Details saved");
	};

	const saveTheme = async (theme: ThemeValue) => {
		if (!museum) return;
		await updateMuseum.mutateAsync({ id: museum.id, theme });
		await refresh();
		toast.success("Theme saved");
	};

	const setCover = async (artworkId: string | null) => {
		if (!museum) return;
		await updateMuseum.mutateAsync({
			id: museum.id,
			coverArtworkId: artworkId,
		});
		await refresh();
		toast.success(artworkId ? "Cover updated" : "Cover reset");
	};

	const togglePublish = async () => {
		if (!museum) return;
		await updateMuseum.mutateAsync({
			id: museum.id,
			isPublished: !museum.isPublished,
		});
		await refresh();
	};

	const deleteMuseum = async () => {
		if (!museum) return;
		await deleteMuseumMut.mutateAsync({ id: museum.id });
		await refresh();
		toast.success("Museum deleted");
	};

	const addRoom = async (name: string) => {
		if (!museum) return undefined;
		const trimmed = name.trim();
		if (!trimmed) return undefined;
		const created = await createRoomMut.mutateAsync({
			museumId: museum.id,
			name: trimmed,
		});
		await refresh();
		toast.success("Room added");
		return created;
	};

	const renameRoom = async (
		roomId: string,
		details: { name: string; description: string },
	) => {
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
		if (!museum) return;
		const ids = museum.rooms.map((r) => r.id);
		const index = ids.indexOf(roomId);
		if (index === -1) return;
		const swapWith = direction === "up" ? index - 1 : index + 1;
		if (swapWith < 0 || swapWith >= ids.length) return;
		[ids[index], ids[swapWith]] = [
			ids[swapWith] as string,
			ids[index] as string,
		];
		void (async () => {
			await reorderRoomsMut.mutateAsync({ museumId: museum.id, roomIds: ids });
			await refresh();
		})();
	};

	return {
		museum,
		loaded: myMuseums.isSuccess,
		archiveLoaded: !archive.isPending,
		rooms,
		available,
		busy,
		saveDetails,
		saveTheme,
		setCover,
		togglePublish,
		deleteMuseum,
		addRoom,
		renameRoom,
		deleteRoom,
		moveRoom,
		addToRoom,
		removeFromRoom,
		moveInRoom,
	};
}
