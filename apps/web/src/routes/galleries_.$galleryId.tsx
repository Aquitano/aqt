import { env } from "@aqt-gallery/env/web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
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

	// Refill the details form whenever the loaded gallery changes.
	useEffect(() => {
		if (group) {
			setDetails({
				name: group.name,
				tagline: group.tagline ?? "",
				description: group.description ?? "",
			});
		}
	}, [group?.id]);

	const refresh = () => queryClient.invalidateQueries();

	const memberIds = group?.artworkIds ?? [];
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
		await setGroupArtworks.mutateAsync({
			groupId: group.id,
			artworkIds,
		});
		await refresh();
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
					<ul className="gallery-member-list">
						{members.map((a, i) => (
							<li key={a.id} className="gallery-member-row">
								<span className="gallery-member-index">{i + 1}</span>
								{thumbUrl(a) ? (
									<img src={thumbUrl(a) ?? undefined} alt="" />
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
										aria-label="Move up"
										className="gallery-icon-control"
										disabled={busy || i === 0}
										onClick={() => {
											const next = [...memberIds];
											[next[i - 1], next[i]] = [next[i], next[i - 1]];
											void syncArtworks(next);
										}}
									>
										<ArrowUp size={15} />
									</button>
									<button
										type="button"
										aria-label="Move down"
										className="gallery-icon-control"
										disabled={busy || i === members.length - 1}
										onClick={() => {
											const next = [...memberIds];
											[next[i], next[i + 1]] = [next[i + 1], next[i]];
											void syncArtworks(next);
										}}
									>
										<ArrowDown size={15} />
									</button>
									<button
										type="button"
										aria-label="Remove from gallery"
										className="gallery-icon-control gallery-icon-control-danger"
										disabled={busy}
										onClick={() => {
											void syncArtworks(memberIds.filter((id) => id !== a.id));
										}}
									>
										<X size={15} />
									</button>
								</div>
							</li>
						))}
					</ul>
				)}

				{/* Archive picker */}
				<p className="gallery-section-label">Your archive — click to add</p>
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
						{available.map((a) => (
							<button
								key={a.id}
								type="button"
								disabled={busy}
								onClick={() => void syncArtworks([...memberIds, a.id])}
								className="gallery-archive-tile"
								title={`Add "${a.title}"`}
							>
								{thumbUrl(a) ? (
									<img src={thumbUrl(a) ?? undefined} alt={a.title} />
								) : (
									<span className="gallery-archive-tile-label">{a.title}</span>
								)}
								<span className="gallery-archive-tile-add">
									<Plus size={14} />
									{a.title}
								</span>
							</button>
						))}
					</div>
				)}
			</section>
		</CosmosShell>
	);
}
