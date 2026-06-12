import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
	const queryClient = useQueryClient();
	const galleries = useQuery(trpc.galleries.list.queryOptions());
	const createGallery = useMutation(trpc.galleries.create.mutationOptions());
	const [editorOpen, setEditorOpen] = useState(false);
	const [search, setSearch] = useState("");
	const visible = (galleries.data ?? []).filter((gallery) =>
		gallery.title.toLowerCase().includes(search.toLowerCase()),
	);

	return (
		<CosmosShell active="galleries" search={search} onSearch={setSearch}>
			<section className="gallery-list-page">
				<div className="gallery-page-heading">
					<div>
						<p className="gallery-eyebrow">Curated pages</p>
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
					{visible.map((gallery) => (
						<Link
							key={gallery.id}
							className="gallery-page-card"
							to="/galleries/$galleryId"
							params={{ galleryId: gallery.id }}
						>
							{gallery.coverUrl ? (
								<img src={gallery.coverUrl} alt="" />
							) : (
								<div className="gallery-page-card-empty" />
							)}
							<h2>{gallery.title}</h2>
							<p>{gallery.description || "A private curated page"}</p>
						</Link>
					))}
					{visible.length === 0 ? (
						<button
							className="gallery-page-card gallery-page-card-create"
							type="button"
							onClick={async () => {
								await createGallery.mutateAsync({
									title: "Untitled gallery",
									sortMode: "manual",
								});
								await queryClient.invalidateQueries();
							}}
						>
							<Plus size={20} />
							<span>Create your first gallery</span>
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
