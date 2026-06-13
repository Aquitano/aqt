import { env } from "@aqt-gallery/env/web";
import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { Check, GripVertical, Plus, Star, X } from "lucide-react";
import { useEffect, useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { GalleryThemePanel } from "@/components/gallery/gallery-theme-panel";
import { useGalleryCuration } from "@/components/gallery/use-gallery-curation";
import { getUser } from "@/functions/get-user";

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
	const navigate = useNavigate();

	const curation = useGalleryCuration(galleryId);
	const { group, members, available, selected, busy } = curation;

	// Controlled details form — local view state, reset on gallery switch.
	const [details, setDetails] = useState({
		name: "",
		tagline: "",
		description: "",
	});
	// Drag DOM state stays in the view; the reorder itself goes through the hook.
	const [dragId, setDragId] = useState<string | null>(null);
	const [overId, setOverId] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on gallery switch
	useEffect(() => {
		if (group) {
			setDetails({
				name: group.name,
				tagline: group.tagline ?? "",
				description: group.description ?? "",
			});
		}
	}, [group?.id]);

	const thumbUrl = (a: { thumbnailUrl: string | null }) =>
		a.thumbnailUrl ? `${env.VITE_SERVER_URL}${a.thumbnailUrl}` : null;

	if (curation.loaded && !group) {
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
							onClick={() => void curation.togglePublish()}
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
								await curation.deleteGroup();
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
							onClick={() => void curation.saveDetails(details)}
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
						onSave={curation.saveTheme}
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
											if (dragId) curation.move(dragId, a.id);
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
													void curation.setCover(explicitCover ? null : a.id)
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
												onClick={() => curation.remove(a.id)}
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
								onClick={curation.clearSelected}
							>
								Clear
							</button>
							<button
								type="button"
								className="gallery-primary-button"
								disabled={busy}
								onClick={curation.addSelected}
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
				{!curation.archiveLoaded ? null : available.length === 0 ? (
					<p className="gallery-muted-note">
						{members.length === 0
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
									onClick={() => curation.toggleSelected(a.id)}
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
