import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { GalleryEditorDialog } from "@/components/gallery/gallery-editor-dialog";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/galleries")({
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
	const trpc = useTRPC();
	const groups = useQuery(trpc.museum.myGroups.queryOptions());
	const [editorOpen, setEditorOpen] = useState(false);
	const [search, setSearch] = useState("");
	const visible = (groups.data ?? []).filter((group) =>
		group.name.toLowerCase().includes(search.toLowerCase()),
	);

	return (
		<CosmosShell active="galleries" search={search} onSearch={setSearch}>
			<section className="gallery-list-page">
				<div className="gallery-page-heading">
					<div>
						<p className="gallery-eyebrow">Curated galleries</p>
						<h1>Galleries</h1>
					</div>
					<button
						className="gallery-primary-button"
						type="button"
						onClick={() => setEditorOpen(true)}
					>
						<Plus size={16} />
						New gallery
					</button>
				</div>
				<div className="gallery-page-grid">
					{visible.map((group) => (
						<Link
							key={group.id}
							className="gallery-page-card"
							to="/galleries/$galleryId"
							params={{ galleryId: group.id }}
						>
							{group.coverImageUrl ? (
								<img src={group.coverImageUrl} alt="" />
							) : (
								<div className="gallery-page-card-empty" />
							)}
							<h2>{group.name}</h2>
							<p>{group.tagline || group.description || "A curated gallery"}</p>
							<div className="gallery-card-meta">
								<span>
									{group.artworkIds.length}{" "}
									{group.artworkIds.length === 1 ? "artwork" : "artworks"}
								</span>
								<span
									className={`gallery-status-badge ${
										group.isPublished ? "gallery-status-badge-published" : ""
									}`}
								>
									{group.isPublished ? "Published" : "Draft"}
								</span>
							</div>
						</Link>
					))}
					{groups.isSuccess && visible.length === 0 ? (
						<button
							className="gallery-page-card gallery-page-card-create"
							type="button"
							onClick={() => setEditorOpen(true)}
						>
							<Plus size={20} />
							<span>
								{search
									? "No galleries match — create a new one"
									: "Create your first gallery"}
							</span>
						</button>
					) : null}
				</div>
				<GalleryEditorDialog
					open={editorOpen}
					onClose={() => setEditorOpen(false)}
				/>
			</section>
		</CosmosShell>
	);
}
