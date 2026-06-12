import { env } from "@aqt-gallery/env/web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

import "@/components/museum/museum.css";

export const Route = createFileRoute("/museum/studio")({
	component: StudioPage,
	beforeLoad: async () => {
		const session = await getUser();
		return { session };
	},
	loader: async ({ context }) => {
		if (!context.session) {
			throw redirect({ to: "/login" });
		}
	},
	head: () => ({
		meta: [{ title: "The Studio — AQT Gallery" }],
	}),
});

const inputClass =
	"w-full rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white/90 outline-none transition-colors placeholder:text-white/30 focus:border-[#cbb87f]/60";

const pillButtonClass =
	"rounded-full border border-[#cbb87f]/50 px-5 py-2 text-[11px] uppercase tracking-[0.22em] text-[#e9dcb4] transition-colors hover:bg-[#cbb87f]/15 disabled:cursor-not-allowed disabled:opacity-40";

const ghostButtonClass =
	"rounded-full border border-white/15 px-5 py-2 text-[11px] uppercase tracking-[0.22em] text-white/60 transition-colors hover:border-white/40 hover:text-white/90";

function StudioPage() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();

	const myGroups = useQuery(trpc.museum.myGroups.queryOptions());
	const artworks = useQuery(trpc.artworks.list.queryOptions({}));

	const createGroup = useMutation(trpc.museum.createGroup.mutationOptions());
	const updateGroup = useMutation(trpc.museum.updateGroup.mutationOptions());
	const deleteGroup = useMutation(trpc.museum.deleteGroup.mutationOptions());
	const setGroupArtworks = useMutation(
		trpc.museum.setGroupArtworks.mutationOptions(),
	);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [newName, setNewName] = useState("");
	const [details, setDetails] = useState({
		name: "",
		tagline: "",
		description: "",
	});

	const groups = myGroups.data ?? [];
	const selected = groups.find((g) => g.id === selectedId) ?? null;

	// Refill the details form whenever a different gallery is selected.
	useEffect(() => {
		if (selected) {
			setDetails({
				name: selected.name,
				tagline: selected.tagline ?? "",
				description: selected.description ?? "",
			});
		}
	}, [selected?.id]);

	const refresh = () => queryClient.invalidateQueries();

	const handleCreate = async () => {
		const name = newName.trim();
		if (!name) return;
		const created = await createGroup.mutateAsync({ name });
		setNewName("");
		await refresh();
		if (created) {
			setSelectedId(created.id);
		}
	};

	const syncArtworks = async (artworkIds: string[]) => {
		if (!selected) return;
		await setGroupArtworks.mutateAsync({
			groupId: selected.id,
			artworkIds,
		});
		await refresh();
	};

	const memberIds = selected?.artworkIds ?? [];
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

	return (
		<main className="min-h-screen bg-[#0b0a09] text-white">
			<header className="flex flex-wrap items-end justify-between gap-4 px-8 pt-8 pb-8 md:px-20">
				<div>
					<p className="text-[#b7a989] text-[10px] uppercase tracking-[0.4em]">
						AQT Gallery
					</p>
					<h1 className="mt-1 font-museum text-3xl text-[#f0e9d8]">
						The Studio
					</h1>
					<p className="mt-2 max-w-xl text-[13px] text-white/50 leading-relaxed">
						Curate your own 3D galleries from the artworks in your archive.
						Artworks you hang become publicly visible; publish the gallery to
						put it on the museum floor.
					</p>
				</div>
				<Link
					to="/museum"
					className="text-[11px] text-white/40 uppercase tracking-[0.24em] transition-colors hover:text-white/80"
				>
					← Back to the museum
				</Link>
			</header>

			<div className="grid gap-10 px-8 pb-24 md:px-20 lg:grid-cols-[340px_1fr]">
				{/* Your galleries */}
				<section>
					<h2 className="text-[#b7a989] text-[11px] uppercase tracking-[0.3em]">
						Your galleries
					</h2>
					<div className="mt-4 flex gap-2">
						<input
							className={inputClass}
							placeholder="Name a new gallery…"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleCreate();
							}}
						/>
						<button
							type="button"
							className={pillButtonClass}
							disabled={createGroup.isPending || newName.trim().length === 0}
							onClick={() => void handleCreate()}
						>
							Create
						</button>
					</div>

					<div className="mt-5 space-y-3">
						{myGroups.isPending ? (
							<div className="museum-skeleton h-20 rounded-xl" />
						) : null}
						{groups.map((g) => (
							<button
								key={g.id}
								type="button"
								onClick={() => setSelectedId(g.id)}
								className={`flex w-full items-center gap-4 rounded-xl border p-3 text-left transition-colors ${
									g.id === selectedId
										? "border-[#cbb87f]/60 bg-[#cbb87f]/10"
										: "border-white/8 bg-white/[0.03] hover:border-white/20"
								}`}
							>
								{g.coverImageUrl ? (
									<img
										src={g.coverImageUrl}
										alt=""
										className="h-14 w-14 shrink-0 rounded-lg object-cover"
									/>
								) : (
									<div className="h-14 w-14 shrink-0 rounded-lg bg-[#1a1713]" />
								)}
								<div className="min-w-0">
									<p className="truncate font-medium text-[#efe8d6]">
										{g.name}
									</p>
									<p className="mt-0.5 text-[11px] text-white/40 uppercase tracking-[0.18em]">
										{g.artworkIds.length} artworks ·{" "}
										{g.isPublished ? (
											<span className="text-[#9fc28f]">published</span>
										) : (
											<span className="text-white/40">draft</span>
										)}
									</p>
								</div>
							</button>
						))}
						{myGroups.isSuccess && groups.length === 0 ? (
							<p className="text-[13px] text-white/40 leading-relaxed">
								No galleries yet. Name one above to start hanging your artworks.
							</p>
						) : null}
					</div>
				</section>

				{/* Editor */}
				<section>
					{!selected ? (
						<div className="flex min-h-[40vh] items-center justify-center rounded-2xl border border-white/10 border-dashed">
							<p className="max-w-sm text-center text-[13px] text-white/40 leading-relaxed">
								Select a gallery on the left — or create a new one — to choose
								which artworks hang in it.
							</p>
						</div>
					) : (
						<div className="space-y-10">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<h2 className="font-museum text-4xl text-[#f0e9d8]">
									{selected.name}
								</h2>
								<div className="flex flex-wrap items-center gap-2">
									<Link
										to="/museum/$kind/$slug"
										params={{ kind: "g", slug: selected.slug }}
										className={pillButtonClass}
									>
										Walk through →
									</Link>
									<button
										type="button"
										className={ghostButtonClass}
										disabled={busy}
										onClick={async () => {
											await updateGroup.mutateAsync({
												id: selected.id,
												isPublished: !selected.isPublished,
											});
											await refresh();
										}}
									>
										{selected.isPublished ? "Unpublish" : "Publish"}
									</button>
									<button
										type="button"
										className="rounded-full border border-red-400/30 px-5 py-2 text-[11px] text-red-300/80 uppercase tracking-[0.22em] transition-colors hover:border-red-400/60 hover:text-red-200"
										disabled={busy}
										onClick={async () => {
											if (
												!window.confirm(
													`Delete "${selected.name}"? The artworks themselves are kept.`,
												)
											) {
												return;
											}
											await deleteGroup.mutateAsync({ id: selected.id });
											setSelectedId(null);
											await refresh();
										}}
									>
										Delete
									</button>
								</div>
							</div>

							{/* Details */}
							<div className="grid gap-3 md:grid-cols-2">
								<input
									className={inputClass}
									placeholder="Gallery name"
									value={details.name}
									onChange={(e) =>
										setDetails((d) => ({ ...d, name: e.target.value }))
									}
								/>
								<input
									className={inputClass}
									placeholder="Tagline (shown in the lobby)"
									value={details.tagline}
									onChange={(e) =>
										setDetails((d) => ({ ...d, tagline: e.target.value }))
									}
								/>
								<textarea
									className={`${inputClass} md:col-span-2`}
									placeholder="Description"
									rows={2}
									value={details.description}
									onChange={(e) =>
										setDetails((d) => ({ ...d, description: e.target.value }))
									}
								/>
								<div>
									<button
										type="button"
										className={pillButtonClass}
										disabled={busy || details.name.trim().length === 0}
										onClick={async () => {
											await updateGroup.mutateAsync({
												id: selected.id,
												name: details.name.trim(),
												tagline: details.tagline.trim() || null,
												description: details.description.trim() || null,
											});
											await refresh();
										}}
									>
										Save details
									</button>
								</div>
							</div>

							{/* Hung artworks (ordered) */}
							<div>
								<h3 className="text-[#b7a989] text-[11px] uppercase tracking-[0.3em]">
									In this gallery — {members.length} artworks
								</h3>
								{members.length === 0 ? (
									<p className="mt-3 text-[13px] text-white/40">
										Nothing hung yet. Add artworks from your archive below.
									</p>
								) : (
									<ul className="mt-4 space-y-2">
										{members.map((a, i) => (
											<li
												key={a.id}
												className="flex items-center gap-4 rounded-xl border border-white/8 bg-white/[0.03] p-2.5"
											>
												<span className="w-6 text-center text-[11px] text-white/35">
													{i + 1}
												</span>
												{thumbUrl(a) ? (
													<img
														src={thumbUrl(a) ?? undefined}
														alt=""
														className="h-12 w-12 shrink-0 rounded-md object-cover"
													/>
												) : (
													<div className="h-12 w-12 shrink-0 rounded-md bg-[#1a1713]" />
												)}
												<div className="min-w-0 flex-1">
													<p className="truncate text-[#efe8d6] text-sm">
														{a.title}
													</p>
													<p className="truncate text-[12px] text-white/40">
														{a.artist ?? "Unknown artist"}
													</p>
												</div>
												<div className="flex items-center gap-1">
													<button
														type="button"
														aria-label="Move up"
														className="rounded-md px-2 py-1 text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-25"
														disabled={busy || i === 0}
														onClick={() => {
															const next = [...memberIds];
															[next[i - 1], next[i]] = [next[i], next[i - 1]];
															void syncArtworks(next);
														}}
													>
														↑
													</button>
													<button
														type="button"
														aria-label="Move down"
														className="rounded-md px-2 py-1 text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-25"
														disabled={busy || i === members.length - 1}
														onClick={() => {
															const next = [...memberIds];
															[next[i], next[i + 1]] = [next[i + 1], next[i]];
															void syncArtworks(next);
														}}
													>
														↓
													</button>
													<button
														type="button"
														aria-label="Remove from gallery"
														className="ml-1 rounded-md px-2 py-1 text-red-300/70 hover:bg-red-400/10 hover:text-red-200 disabled:opacity-25"
														disabled={busy}
														onClick={() => {
															void syncArtworks(
																memberIds.filter((id) => id !== a.id),
															);
														}}
													>
														✕
													</button>
												</div>
											</li>
										))}
									</ul>
								)}
							</div>

							{/* Archive picker */}
							<div>
								<h3 className="text-[#b7a989] text-[11px] uppercase tracking-[0.3em]">
									Your archive — click to hang
								</h3>
								<p className="mt-2 text-[12px] text-white/35">
									Adding an artwork publishes it to the museum so visitors can
									see it.
								</p>
								{artworks.isPending ? (
									<div className="museum-skeleton mt-4 h-40 rounded-xl" />
								) : available.length === 0 ? (
									<p className="mt-4 text-[13px] text-white/40">
										{(artworks.data ?? []).length === 0
											? "Your archive is empty — add artworks to it first."
											: "Every artwork in your archive is already hanging here."}
									</p>
								) : (
									<div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
										{available.map((a) => (
											<button
												key={a.id}
												type="button"
												disabled={busy}
												onClick={() => void syncArtworks([...memberIds, a.id])}
												className="group relative aspect-square overflow-hidden rounded-lg border border-white/8 bg-[#12100d] transition-colors hover:border-[#cbb87f]/50"
												title={`Hang "${a.title}"`}
											>
												{thumbUrl(a) ? (
													<img
														src={thumbUrl(a) ?? undefined}
														alt={a.title}
														className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
													/>
												) : (
													<span className="flex h-full w-full items-center justify-center p-2 text-center text-[11px] text-white/40">
														{a.title}
													</span>
												)}
												<span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pt-5 pb-1.5 text-left text-[11px] text-white/85 opacity-0 transition-opacity group-hover:opacity-100">
													+ {a.title}
												</span>
											</button>
										))}
									</div>
								)}
							</div>
						</div>
					)}
				</section>
			</div>
		</main>
	);
}
