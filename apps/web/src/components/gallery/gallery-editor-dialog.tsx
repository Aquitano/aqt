import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

export function GalleryEditorDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const createGallery = useMutation(trpc.galleries.create.mutationOptions());
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");

	if (!open) {
		return null;
	}

	return (
		<div className="gallery-modal-backdrop">
			<section
				className="gallery-import-dialog gallery-compact-dialog"
				aria-label="Create gallery"
			>
				<div className="gallery-dialog-header">
					<div>
						<p className="gallery-eyebrow">Gallery page</p>
						<h2>Create a curated page</h2>
					</div>
					<button
						aria-label="Close"
						className="gallery-icon-button"
						type="button"
						onClick={onClose}
					>
						<X size={18} />
					</button>
				</div>
				<label className="gallery-field">
					<span>Title</span>
					<input
						value={title}
						onChange={(event) => setTitle(event.target.value)}
					/>
				</label>
				<label className="gallery-field">
					<span>Description</span>
					<textarea
						value={description}
						onChange={(event) => setDescription(event.target.value)}
					/>
				</label>
				<div className="gallery-dialog-actions">
					<button
						className="gallery-primary-button"
						type="button"
						onClick={async () => {
							if (!title.trim()) {
								return;
							}
							await createGallery.mutateAsync({
								title,
								description,
								sortMode: "manual",
							});
							await queryClient.invalidateQueries();
							toast.success("Gallery created");
							onClose();
						}}
					>
						Create gallery
					</button>
				</div>
			</section>
		</div>
	);
}
