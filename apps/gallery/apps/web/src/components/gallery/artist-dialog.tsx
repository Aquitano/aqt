import { Button } from "@aqt-gallery/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@aqt-gallery/ui/components/dialog";
import { Input } from "@aqt-gallery/ui/components/input";
import { Label } from "@aqt-gallery/ui/components/label";
import { Textarea } from "@aqt-gallery/ui/components/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

export type ArtistRow = {
	id: string;
	userId: string | null;
	name: string;
	bio: string | null;
	birthYear: number | null;
	deathYear: number | null;
	nationality: string | null;
	portraitUrl: string | null;
};

const empty = {
	name: "",
	nationality: "",
	birthYear: "",
	deathYear: "",
	portraitUrl: "",
	bio: "",
};

/**
 * Create or edit an artist (bio / dates / nationality / portrait). Seeded
 * global artists are read-only, so editing/deleting is only offered for the
 * caller's own artists (`userId` set).
 */
export function ArtistDialog({
	open,
	onOpenChange,
	artist,
	onCreated,
	onDeleted,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	artist?: ArtistRow | null;
	onCreated?: (id: string) => void;
	onDeleted?: (id: string) => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const createArtist = useMutation(trpc.artists.create.mutationOptions());
	const updateArtist = useMutation(trpc.artists.update.mutationOptions());
	const deleteArtist = useMutation(trpc.artists.delete.mutationOptions());
	const [form, setForm] = useState(empty);

	const editing = Boolean(artist);
	const ownArtist = Boolean(artist?.userId);

	useEffect(() => {
		if (!open) return;
		setForm(
			artist
				? {
						name: artist.name,
						nationality: artist.nationality ?? "",
						birthYear: artist.birthYear ? String(artist.birthYear) : "",
						deathYear: artist.deathYear ? String(artist.deathYear) : "",
						portraitUrl: artist.portraitUrl ?? "",
						bio: artist.bio ?? "",
					}
				: empty,
		);
	}, [open, artist]);

	const busy =
		createArtist.isPending || updateArtist.isPending || deleteArtist.isPending;

	const toYear = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
	};

	const submit = async () => {
		const name = form.name.trim();
		if (!name) return;
		const payload = {
			name,
			bio: form.bio.trim() || null,
			nationality: form.nationality.trim() || null,
			birthYear: toYear(form.birthYear),
			deathYear: toYear(form.deathYear),
			portraitUrl: form.portraitUrl.trim() || null,
		};
		if (artist && ownArtist) {
			await updateArtist.mutateAsync({ id: artist.id, ...payload });
			toast.success("Artist updated");
		} else {
			const created = await createArtist.mutateAsync(payload);
			toast.success("Artist created");
			if (created) onCreated?.(created.id);
		}
		await queryClient.invalidateQueries();
		onOpenChange(false);
	};

	const remove = async () => {
		if (!artist) return;
		await deleteArtist.mutateAsync({ id: artist.id });
		await queryClient.invalidateQueries();
		toast.success("Artist deleted");
		onDeleted?.(artist.id);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{editing ? "Edit artist" : "New artist"}</DialogTitle>
					<DialogDescription>
						{editing && !ownArtist
							? "This is a built-in reference artist and can't be edited."
							: "Bio, dates and nationality appear on the artist's wall in the 3D museum."}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="artist-name">Name</Label>
						<Input
							id="artist-name"
							autoFocus
							disabled={editing && !ownArtist}
							value={form.name}
							onChange={(event) =>
								setForm({ ...form, name: event.target.value })
							}
						/>
					</div>
					<div className="grid grid-cols-3 gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="artist-nationality">Nationality</Label>
							<Input
								id="artist-nationality"
								disabled={editing && !ownArtist}
								value={form.nationality}
								onChange={(event) =>
									setForm({ ...form, nationality: event.target.value })
								}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="artist-birth">Born</Label>
							<Input
								id="artist-birth"
								inputMode="numeric"
								placeholder="1853"
								disabled={editing && !ownArtist}
								value={form.birthYear}
								onChange={(event) =>
									setForm({ ...form, birthYear: event.target.value })
								}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="artist-death">Died</Label>
							<Input
								id="artist-death"
								inputMode="numeric"
								placeholder="1890"
								disabled={editing && !ownArtist}
								value={form.deathYear}
								onChange={(event) =>
									setForm({ ...form, deathYear: event.target.value })
								}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="artist-portrait">Portrait URL</Label>
						<Input
							id="artist-portrait"
							placeholder="https://…"
							disabled={editing && !ownArtist}
							value={form.portraitUrl}
							onChange={(event) =>
								setForm({ ...form, portraitUrl: event.target.value })
							}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="artist-bio">Bio</Label>
						<Textarea
							id="artist-bio"
							disabled={editing && !ownArtist}
							value={form.bio}
							onChange={(event) =>
								setForm({ ...form, bio: event.target.value })
							}
						/>
					</div>
				</div>
				<DialogFooter className="sm:justify-between">
					{editing && ownArtist ? (
						<Button
							variant="destructive"
							onClick={() => void remove()}
							disabled={busy}
						>
							<Trash2 />
							Delete
						</Button>
					) : (
						<span />
					)}
					<div className="flex flex-col-reverse gap-2 sm:flex-row">
						<Button
							variant="ghost"
							onClick={() => onOpenChange(false)}
							disabled={busy}
						>
							Cancel
						</Button>
						{!(editing && !ownArtist) ? (
							<Button
								onClick={() => void submit()}
								disabled={busy || form.name.trim().length === 0}
							>
								{editing ? "Save artist" : "Create artist"}
							</Button>
						) : null}
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
