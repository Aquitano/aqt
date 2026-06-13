import { env } from "@aqt-gallery/env/web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { Check, GripVertical, Plus, Star, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import {
	GalleryThemePanel,
	type GalleryThemeValue,
} from "@/components/gallery/gallery-theme-panel";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/galleries_/$galleryId")({
	component: RouteComponent,
	beforeLoad: async () => {
		const session = await getUser();
		return { session };
	},
	loader: async ({ context }) => {
		if (!context.session) {
			throw redirect({ to: "/login" });
		}
	},
});

function RouteComponent() {
	const { galleryId } = Route.useParams();
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const myGroups = useQuery(trpc.museum.myGroups.queryOptions());
	const artworks = useQuery(trpc.artworks.list.queryOptions({}));

	const updateGroup = useMutation(trpc.museum.updateGroup.mutationOptions());
	const deleteGroup = useMutation(trpc.museum.deleteGroup.mutationOptions());
	const setGroupArtworks = useMutation(
		trpc.museum.setGroupArtworks.mutationOptions(),
	);

	const group = (myGroups.data ?? []).find((g) => g.id === galleryId) ?? null;

	const [details, setDetails] = useState({
		name: "",
		tagline: "",
		description: "",
	});
	// Optimistic membership order so add/remove/reorder feel instant; null
	// means "use the server's order". Selection is the bulk-add staging set.
	const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [dragId, setDragId] = useState<string | null>(null);
	const [overId, setOverId] = useState<string | null>(null);

	// Refill the per-gallery local state whenever the loaded gallery changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on gallery switch
	useEffect(() => {
		if (group) {
			setDetails({
				name: group.name,
				tagline: group.tagline ?? "",
				description: group.description ?? "",
			});
		}
		setPendingOrder(null);
		setSelected(new Set());
	}, [group?.id]);

	const refresh = () => queryClient.invalidateQueries();

	const serverIds = group?.artworkIds ?? [];
	const memberIds = pendingOrder ?? serverIds;
	const artworkById = new Map((artworks.data ?? []).map((a) => [a.id, a]));
	const members = memberIds
		.map((id) => artworkById.get(id))
		.filter((a) => a !== undefined);
	const available = (artworks.data ?? []).filter(
		(a) => !memberIds.includes(a.id),
	);

	const thumbUrl = (a: { thumbnailUrl: string | null }) =>
		a.thumbnailUrl ? `${env.VITE_SERVER_URL}${a.thumbnailUrl}` : null;

	const busy =
		setGroupArtworks.isPending ||
		updateGroup.isPending ||
		deleteGroup.isPending;

	const syncArtworks = async (artworkIds: string[]) => {
		if (!group) return;
		setPendingOrder(artworkIds);
		try {
			await setGroupArtworks.mutateAsync({ groupId: group.id, artworkIds });
			await refresh();
		} catch {
			toast.error("Couldn't save changes");
		} finally {
			setPendingOrder(null);
		}
	};

	const saveTheme = async (theme: GalleryThemeValue) => {
		if (!group) return;
		await updateGroup.mutateAsync({ id: group.id, theme });
		await refresh();
		toast.success("Theme saved");
	};

	const setCover = async (artworkId: string | null) => {
		if (!group) return;
		await updateGroup.mutateAsync({ id: group.id, coverArtworkId: artworkId });
		await refresh();
		toast.success(artworkId ? "Cover updated" : "Cover reset");
	};

	const moveMember = (sourceId: string, targetId: string) => {
		if (sourceId === targetId) return;
		const ids = [...memberIds];
		const from = ids.indexOf(sourceId);
		const to = ids.indexOf(targetId);
		if (from === -1 || to === -1) return;
		ids.splice(from, 1);
		ids.splice(to, 0, sourceId);
		void syncArtworks(ids);
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

	const addSelected = () => {
		const toAdd = available.filter((a) => selected.has(a.id)).map((a) => a.id);
		if (toAdd.length === 0) return;
		setSelected(new Set());
		void syncArtworks([...memberIds, ...toAdd]);
	};

	if (myGroups.isSuccess && !group) {
		return (
			<CosmosShell active="galleries">
				<section className="gallery-list-page">
					<div className="gallery-empty-state">
						<h1>Gallery not found.</h1>
						<p>
							This gallery may have been deleted, or it belongs to another
							account.
						</p>
						<Link className="gallery-secondary-button" to="/galleries">
							← Back to galleries
						</Link>
					</div>
				</section>
			</CosmosShell>
		);
	}

	return (
		<CosmosShell active="galleries">
			<section className="gallery-list-page">
				<div className="gallery-page-heading gallery-detail-heading">
					<div>
						<p className="gallery-eyebrow">Curated gallery</p>
						<h1>{group?.name ?? "Gallery"}</h1>
						{group?.tagline ? <p>{group.tagline}</p> : null}
					</div>
					<div className="gallery-editor-actions">
						{group ? (
							<Link
								className="gallery-secondary-button"
								to="/museum/$kind/$slug"
								params={{ kind: "g", slug: group.slug }}
							>
								Walk through →
							</Link>
						) : null}
						<button
							type="button"
							className="gallery-secondary-button"
							disabled={busy || !group}
							onClick={async () => {
								if (!group) return;
								await updateGroup.mutateAsync({
									id: group.id,
									isPublished: !group.isPublished,
								});
								await refresh();
							}}
						>
							{group?.isPublished ? "Unpublish" : "Publish"}
						</button>
						<button
							type="button"
							className="gallery-danger-button"
							disabled={busy || !group}
							onClick={async () => {
								if (!group) return;
								if (
									!window.confirm(
										`Delete "${group.name}"? The artworks themselves are kept.`,
									)
								) {
									return;
								}
								await deleteGroup.mutateAsync({ id: group.id });
								await refresh();
								toast.success("Gallery deleted");
								navigate({ to: "/galleries" });
							}}
						>
							Delete
						</button>
					</div>
				</div>

				{/* Details */}
				<div className="gallery-editor-details">
					<label className="gallery-field">
						<span>Name</span>
						<input
							value={details.name}
							onChange={(e) =>
								setDetails((d) => ({ ...d, name: e.target.value }))
							}
						/>
					</label>
					<label className="gallery-field">
						<span>Tagline</span>
						<input
							value={details.tagline}
							onChange={(e) =>
								setDetails((d) => ({ ...d, tagline: e.target.value }))
							}
						/>
					</label>
					<label className="gallery-field gallery-field-wide">
						<span>Description</span>
						<textarea
							rows={2}
							value={details.description}
							onChange={(e) =>
								setDetails((d) => ({ ...d, description: e.target.value }))
							}
						/>
					</label>
					<div>
						<button
							type="button"
							className="gallery-primary-button gallery-save-button"
							disabled={busy || details.name.trim().length === 0}
							onClick={async () => {
								if (!group) return;
								await updateGroup.mutateAsync({
									id: group.id,
									name: details.name.trim(),
									tagline: details.tagline.trim() || null,
									description: details.description.trim() || null,
								});
								await refresh();
								toast.success("Details saved");
							}}
						>
							Save details
						</button>
					</div>
				</div>

				{/* Room theme */}
				<p className="gallery-section-label">Room theme</p>
				<p className="gallery-muted-note">
					How this gallery's 3D room looks when visitors walk through.
				</p>
				{group ? (
					<GalleryThemePanel
						groupId={group.id}
						theme={group.theme}
						disabled={busy}
						onSave={saveTheme}
					/>
				) : null}

				{/* Hung artworks (ordered) */}
				<p className="gallery-section-label">
					In this gallery — {members.length}{" "}
					{members.length === 1 ? "artwork" : "artworks"}
				</p>
				{members.length === 0 ? (
					<p className="gallery-muted-note">
						Nothing here yet. Add artworks from your archive below.
					</p>
				) : (
					<>
						<p className="gallery-muted-note">
							Drag to reorder. The star sets the gallery cover.
						</p>
						<ul className="gallery-member-list">
							{members.map((a, i) => {
								const isCover = group?.coverArtworkId
									? group.coverArtworkId === a.id
									: i === 0;
								const explicitCover = group?.coverArtworkId === a.id;
								return (
									<li
										key={a.id}
										className={`gallery-member-row${
											dragId === a.id ? "gallery-member-row-dragging" : ""
										}${overId === a.id && dragId && dragId !== a.id ? "gallery-member-row-over" : ""}`}
										draggable={!busy}
										onDragStart={(e) => {
											setDragId(a.id);
											e.dataTransfer.effectAllowed = "move";
											// Firefox only starts a drag once data is set.
											e.dataTransfer.setData("text/plain", a.id);
										}}
										onDragOver={(e) => {
											e.preventDefault();
											e.dataTransfer.dropEffect = "move";
											if (overId !== a.id) setOverId(a.id);
										}}
										onDrop={(e) => {
											e.preventDefault();
											if (dragId) moveMember(dragId, a.id);
											setDragId(null);
											setOverId(null);
										}}
										onDragEnd={() => {
											setDragId(null);
											setOverId(null);
										}}
									>
										<span
											className="gallery-member-grip"
											aria-hidden="true"
											title="Drag to reorder"
										>
											<GripVertical size={16} />
										</span>
										<span className="gallery-member-index">{i + 1}</span>
										{thumbUrl(a) ? (
											<img
												src={thumbUrl(a) ?? undefined}
												alt=""
												draggable={false}
											/>
										) : (
											<div className="gallery-member-thumb-empty" />
										)}
										<div className="gallery-member-meta">
											<p className="gallery-member-title">{a.title}</p>
											<p className="gallery-member-artist">
												{a.artist ?? "Unknown artist"}
											</p>
										</div>
										<div className="gallery-member-controls">
											<button
												type="button"
												aria-label={
													explicitCover
														? "Current cover — click to reset"
														: "Set as cover"
												}
												aria-pressed={explicitCover}
												title={
													explicitCover
														? "Current cover — click to reset"
														: "Set as cover"
												}
												className={`gallery-icon-control${
													isCover ? "gallery-icon-control-active" : ""
												}`}
												disabled={busy}
												onClick={() =>
													void setCover(explicitCover ? null : a.id)
												}
											>
												<Star
													size={15}
													fill={isCover ? "currentColor" : "none"}
												/>
											</button>
											<button
												type="button"
												aria-label="Remove from gallery"
												className="gallery-icon-control gallery-icon-control-danger"
												disabled={busy}
												onClick={() => {
													void syncArtworks(
														memberIds.filter((id) => id !== a.id),
													);
												}}
											>
												<X size={15} />
											</button>
										</div>
									</li>
								);
							})}
						</ul>
					</>
				)}

				{/* Archive picker */}
				<div className="gallery-archive-heading">
					<p className="gallery-section-label">Your archive — tap to select</p>
					{selected.size > 0 ? (
						<div className="gallery-archive-bulk">
							<button
								type="button"
								className="gallery-secondary-button"
								disabled={busy}
								onClick={() => setSelected(new Set())}
							>
								Clear
							</button>
							<button
								type="button"
								className="gallery-primary-button"
								disabled={busy}
								onClick={addSelected}
							>
								<Plus size={15} />
								Add {selected.size} selected
							</button>
						</div>
					) : null}
				</div>
				<p className="gallery-muted-note">
					Adding an artwork publishes it so it can appear in the museum.
				</p>
				{artworks.isPending ? null : available.length === 0 ? (
					<p className="gallery-muted-note">
						{(artworks.data ?? []).length === 0
							? "Your archive is empty — import artworks first."
							: "Every artwork in your archive is already in this gallery."}
					</p>
				) : (
					<div className="gallery-archive-grid">
						{available.map((a) => {
							const isSelected = selected.has(a.id);
							return (
								<button
									key={a.id}
									type="button"
									aria-pressed={isSelected}
									onClick={() => toggleSelected(a.id)}
									className={`gallery-archive-tile${
										isSelected ? "gallery-archive-tile-selected" : ""
									}`}
									title={`Select "${a.title}"`}
								>
									{thumbUrl(a) ? (
										<img src={thumbUrl(a) ?? undefined} alt={a.title} />
									) : (
										<span className="gallery-archive-tile-label">
											{a.title}
										</span>
									)}
									<span
										className="gallery-archive-tile-check"
										aria-hidden="true"
									>
										<Check size={14} />
									</span>
									<span className="gallery-archive-tile-add">{a.title}</span>
								</button>
							);
						})}
					</div>
				)}
			</section>
		</CosmosShell>
	);
}
