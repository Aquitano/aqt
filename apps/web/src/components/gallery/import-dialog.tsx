import { env } from "@aqt-gallery/env/web";
import { X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type ImportDialogProps = {
	open: boolean;
	onClose: () => void;
	onUploaded: () => void;
};

export function ImportDialog({ open, onClose, onUploaded }: ImportDialogProps) {
	const [files, setFiles] = useState<File[]>([]);
	const [isUploading, setIsUploading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const previews = useMemo(
		() => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
		[files],
	);

	if (!open) {
		return null;
	}

	const addFiles = (incoming: FileList | File[]) => {
		setFiles((current) => [
			...current,
			...Array.from(incoming).filter((file) => file.type.startsWith("image/")),
		]);
	};

	const upload = async () => {
		if (files.length === 0) {
			return;
		}

		setIsUploading(true);
		const formData = new FormData();
		for (const file of files) {
			formData.append("files", file);
		}

		const response = await fetch(`${env.VITE_SERVER_URL}/media/upload`, {
			method: "POST",
			body: formData,
			credentials: "include",
		});

		setIsUploading(false);

		if (!response.ok) {
			toast.error(await response.text());
			return;
		}

		setFiles([]);
		toast.success("Imported into archive");
		onUploaded();
		onClose();
	};

	return (
		<div className="gallery-modal-backdrop" role="presentation">
			<section aria-label="Import media" className="gallery-import-dialog">
				<div className="gallery-dialog-header">
					<div>
						<p className="gallery-eyebrow">Bulk import</p>
						<h2>Add images to your archive</h2>
					</div>
					<button
						aria-label="Close import dialog"
						className="gallery-icon-button"
						type="button"
						onClick={onClose}
					>
						<X size={18} />
					</button>
				</div>
				<button
					className="gallery-drop-zone"
					type="button"
					onClick={() => inputRef.current?.click()}
					onDragOver={(event) => event.preventDefault()}
					onDrop={(event) => {
						event.preventDefault();
						addFiles(event.dataTransfer.files);
					}}
				>
					<span>Drop images here</span>
					<small>JPEG, PNG, WebP, or GIF. Multiple files are accepted.</small>
				</button>
				<input
					ref={inputRef}
					className="sr-only"
					type="file"
					accept="image/jpeg,image/png,image/webp,image/gif"
					multiple
					onChange={(event) => {
						if (event.target.files) {
							addFiles(event.target.files);
						}
					}}
				/>
				{previews.length > 0 ? (
					<div className="gallery-import-preview">
						{previews.map(({ file, url }) => (
							<figure key={`${file.name}-${file.lastModified}`}>
								<img src={url} alt={file.name} />
								<figcaption>{file.name}</figcaption>
							</figure>
						))}
					</div>
				) : null}
				<div className="gallery-dialog-actions">
					<button
						className="gallery-secondary-button"
						type="button"
						onClick={() => setFiles([])}
					>
						Clear
					</button>
					<button
						className="gallery-primary-button"
						type="button"
						disabled={files.length === 0 || isUploading}
						onClick={upload}
					>
						{isUploading ? "Importing..." : `Import ${files.length || ""}`}
					</button>
				</div>
			</section>
		</div>
	);
}
