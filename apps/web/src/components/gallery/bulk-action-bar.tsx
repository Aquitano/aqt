import { Button } from "@aqt-gallery/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@aqt-gallery/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@aqt-gallery/ui/components/dropdown-menu";
import { Input } from "@aqt-gallery/ui/components/input";
import { Label } from "@aqt-gallery/ui/components/label";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Shapes, Tag, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

import type { ArtworkCard, ArtworkType } from "./types";

const TYPES: { value: ArtworkType; label: string }[] = [
	{ value: "painting", label: "Painting" },
	{ value: "photo", label: "Photo" },
	{ value: "sculpture", label: "Sculpture" },
	{ value: "print", label: "Print" },
	{ value: "object", label: "Object" },
	{ value: "other", label: "Other" },
];

/**
 * Floating toolbar for acting on a selection of archive artworks at once.
 * Type changes go through the batched `artworks.bulkUpdate`; tagging and
 * deletion fan out one call per artwork (tags must merge with each work's
 * existing set, and delete has no batch endpoint).
 */
export function BulkActionBar({
	selected,
	cards,
	onClear,
}: {
	selected: string[];
	cards: ArtworkCard[];
	onClear: () => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const bulkUpdate = useMutation(trpc.artworks.bulkUpdate.mutationOptions());
	const setTags = useMutation(trpc.tags.setArtworkTags.mutationOptions());
	const deleteArtwork = useMutation(trpc.artworks.delete.mutationOptions());
	const [tagOpen, setTagOpen] = useState(false);
	const [tagValue, setTagValue] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);

	const count = selected.length;
	const busy =
		bulkUpdate.isPending || setTags.isPending || deleteArtwork.isPending;
	const selectedCards = cards.filter((card) => selected.includes(card.id));

	const setType = async (artworkType: ArtworkType) => {
		await bulkUpdate.mutateAsync({
			artworks: selected.map((id) => ({ id, artworkType })),
		});
		await queryClient.invalidateQueries();
		toast.success(`Set type on ${count} ${count === 1 ? "work" : "works"}`);
		onClear();
	};

	const addTag = async () => {
		const name = tagValue.trim();
		if (!name) return;
		// Merge the new tag into each work's existing set — setArtworkTags
		// replaces the whole list, so we must send the union.
		await Promise.all(
			selectedCards.map((card) => {
				const names = card.tags.map((tag) => tag.name);
				if (
					names.some(
						(existing) => existing.toLowerCase() === name.toLowerCase(),
					)
				)
					return Promise.resolve();
				return setTags.mutateAsync({
					artworkId: card.id,
					tagNames: [...names, name],
				});
			}),
		);
		await queryClient.invalidateQueries();
		toast.success(`Tagged ${count} ${count === 1 ? "work" : "works"}`);
		setTagValue("");
		setTagOpen(false);
		onClear();
	};

	const removeSelected = async () => {
		await Promise.all(selected.map((id) => deleteArtwork.mutateAsync({ id })));
		await queryClient.invalidateQueries();
		toast.success(`Deleted ${count} ${count === 1 ? "work" : "works"}`);
		setConfirmDelete(false);
		onClear();
	};

	return (
		<>
			<div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 border bg-popover/95 px-3 py-2 text-popover-foreground shadow-2xl ring-1 ring-foreground/10 backdrop-blur-md">
				<span className="px-1 font-medium text-sm tabular-nums">
					{count} selected
				</span>

				<DropdownMenu>
					<DropdownMenuTrigger
						render={<Button variant="outline" size="sm" disabled={busy} />}
					>
						<Shapes />
						Set type
					</DropdownMenuTrigger>
					<DropdownMenuContent align="center" className="min-w-40">
						{TYPES.map((type) => (
							<DropdownMenuItem
								key={type.value}
								onClick={() => void setType(type.value)}
							>
								{type.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>

				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => setTagOpen(true)}
				>
					<Tag />
					Add tag
				</Button>

				<Button
					variant="destructive"
					size="sm"
					disabled={busy}
					onClick={() => setConfirmDelete(true)}
				>
					<Trash2 />
					Delete
				</Button>

				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Clear selection"
					disabled={busy}
					onClick={onClear}
				>
					<X />
				</Button>
			</div>

			<Dialog open={tagOpen} onOpenChange={setTagOpen}>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>Add a tag</DialogTitle>
						<DialogDescription>
							Adds this tag to {count} selected {count === 1 ? "work" : "works"}
							, keeping their existing tags.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="bulk-tag">Tag</Label>
						<Input
							id="bulk-tag"
							autoFocus
							value={tagValue}
							placeholder="e.g. Impressionism"
							onChange={(event) => setTagValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void addTag();
							}}
						/>
					</div>
					<DialogFooter>
						<Button
							variant="ghost"
							onClick={() => setTagOpen(false)}
							disabled={setTags.isPending}
						>
							Cancel
						</Button>
						<Button
							onClick={() => void addTag()}
							disabled={setTags.isPending || tagValue.trim().length === 0}
						>
							Add tag
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>
							Delete {count} {count === 1 ? "artwork" : "artworks"}?
						</DialogTitle>
						<DialogDescription>
							The selected {count === 1 ? "artwork" : "artworks"} will be
							permanently removed from your archive and any galleries they hang
							in. This can't be undone.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="ghost"
							onClick={() => setConfirmDelete(false)}
							disabled={deleteArtwork.isPending}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => void removeSelected()}
							disabled={deleteArtwork.isPending}
						>
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
