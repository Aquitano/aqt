import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
	const navigate = useNavigate();
	const createGroup = useMutation(trpc.museum.createGroup.mutationOptions());
	const [name, setName] = useState("");
	const [tagline, setTagline] = useState("");
	const [description, setDescription] = useState("");

	if (!open) {
		return null;
	}

	const reset = () => {
		setName("");
		setTagline("");
		setDescription("");
	};

	const submit = async () => {
		if (!name.trim()) {
			return;
		}
		const created = await createGroup.mutateAsync({
			name: name.trim(),
			tagline: tagline.trim() || null,
			description: description.trim() || null,
		});
		await queryClient.invalidateQueries();
		toast.success("Gallery created");
		reset();
		onClose();
		if (created) {
			navigate({
				to: "/galleries/$galleryId",
				params: { galleryId: created.id },
			});
		}
	};

	return (
		<div className="gallery-modal-backdrop">
			<section
				className="gallery-import-dialog gallery-compact-dialog"
				aria-label="Create gallery"
			>
				<div className="gallery-dialog-header">
					<div>
						<p className="gallery-eyebrow">Curated gallery</p>
						<h2>Create a gallery</h2>
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
					<span>Name</span>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void submit();
						}}
					/>
				</label>
				<label className="gallery-field">
					<span>Tagline</span>
					<input
						placeholder="Shown beneath the title"
						value={tagline}
						onChange={(event) => setTagline(event.target.value)}
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
						disabled={createGroup.isPending || name.trim().length === 0}
						onClick={() => void submit()}
					>
						Create gallery
					</button>
				</div>
			</section>
		</div>
	);
}
