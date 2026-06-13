import { env } from "@aqt-gallery/env/web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

type CustomField = { label: string; value: string; position: number };

export function ArtworkDetailEditor({ artworkId }: { artworkId: string }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const detail = useQuery(trpc.artworks.get.queryOptions({ id: artworkId }));
	const updateArtwork = useMutation(trpc.artworks.update.mutationOptions());
	const setCustomFields = useMutation(
		trpc.artworks.setCustomFields.mutationOptions(),
	);
	const setTags = useMutation(trpc.tags.setArtworkTags.mutationOptions());
	const [form, setForm] = useState({
		title: "",
		artist: "",
		artworkType: "other" as const,
		year: "",
		seenAt: "",
		rating: 0,
		review: "",
		thoughts: "",
		description: "",
		sourceUrl: "",
		tags: "",
	});
	const [customFields, setCustomFieldState] = useState<CustomField[]>([]);
	const image = detail.data?.image;
	const imageUrl = image ? `${env.VITE_SERVER_URL}${image.originalUrl}` : null;

	useEffect(() => {
		const data = detail.data;
		if (!data) {
			return;
		}
		setForm({
			title: data.artwork.title,
			artist: data.artwork.artist ?? "",
			artworkType: data.artwork.artworkType as typeof form.artworkType,
			year: data.artwork.year ?? "",
			seenAt: data.artwork.seenAt
				? new Date(data.artwork.seenAt).toISOString().slice(0, 10)
				: "",
			rating: data.artwork.rating ?? 0,
			review: data.artwork.review ?? "",
			thoughts: data.artwork.thoughts ?? "",
			description: data.artwork.description ?? "",
			sourceUrl: data.artwork.sourceUrl ?? "",
			tags: data.tags.map((tag) => tag.name).join(", "),
		});
		setCustomFieldState(
			data.customFields.map((field) => ({
				label: field.label,
				value: field.value,
				position: field.position,
			})),
		);
	}, [detail.data]);

	const customFieldsWithPositions = useMemo(
		() => customFields.map((field, index) => ({ ...field, position: index })),
		[customFields],
	);

	if (detail.isLoading) {
		return <div className="gallery-empty-state">Loading artwork...</div>;
	}

	if (!detail.data) {
		return (
			<div className="gallery-empty-state">
				<h1>Artwork not found.</h1>
				<Link to="/dashboard">Return to archive</Link>
			</div>
		);
	}

	const save = async () => {
		await updateArtwork.mutateAsync({
			id: artworkId,
			title: form.title,
			artist: form.artist || null,
			artworkType: form.artworkType,
			year: form.year || null,
			seenAt: form.seenAt || null,
			rating: form.rating || null,
			review: form.review || null,
			thoughts: form.thoughts || null,
			description: form.description || null,
			sourceUrl: form.sourceUrl || null,
		});
		await setCustomFields.mutateAsync({
			artworkId,
			fields: customFieldsWithPositions.filter((field) => field.label),
		});
		await setTags.mutateAsync({
			artworkId,
			tagNames: form.tags
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean),
		});
		await queryClient.invalidateQueries();
		toast.success("Artwork saved");
	};

	return (
		<div className="artwork-detail-layout">
			<section className="artwork-detail-preview">
				{imageUrl ? (
					<img src={imageUrl} alt={form.title} />
				) : (
					<div className="artwork-tile-empty">No image</div>
				)}
			</section>
			<aside className="artwork-detail-sidebar">
				<section className="detail-panel">
					<div className="detail-panel-heading">
						<h1>{form.title || "Untitled artwork"}</h1>
						<button
							className="gallery-primary-button gallery-save-button"
							type="button"
							onClick={save}
						>
							<Save size={15} />
							Save
						</button>
					</div>
					<div className="detail-form-grid">
						<label className="gallery-field">
							<span>Title</span>
							<input
								value={form.title}
								onChange={(event) =>
									setForm({ ...form, title: event.target.value })
								}
							/>
						</label>
						<label className="gallery-field">
							<span>Artist</span>
							<input
								value={form.artist}
								onChange={(event) =>
									setForm({ ...form, artist: event.target.value })
								}
							/>
						</label>
						<label className="gallery-field">
							<span>Type</span>
							<select
								value={form.artworkType}
								onChange={(event) =>
									setForm({
										...form,
										artworkType: event.target.value as typeof form.artworkType,
									})
								}
							>
								<option value="painting">Painting</option>
								<option value="photo">Photo</option>
								<option value="sculpture">Sculpture</option>
								<option value="print">Print</option>
								<option value="object">Object</option>
								<option value="other">Other</option>
							</select>
						</label>
						<label className="gallery-field">
							<span>Year</span>
							<input
								value={form.year}
								onChange={(event) =>
									setForm({ ...form, year: event.target.value })
								}
							/>
						</label>
						<label className="gallery-field">
							<span>Seen</span>
							<input
								type="date"
								value={form.seenAt}
								onChange={(event) =>
									setForm({ ...form, seenAt: event.target.value })
								}
							/>
						</label>
						<label className="gallery-field">
							<span>Rating</span>
							<input
								type="number"
								min="0"
								max="5"
								value={form.rating}
								onChange={(event) =>
									setForm({ ...form, rating: Number(event.target.value) })
								}
							/>
						</label>
					</div>
					<label className="gallery-field">
						<span>Tags</span>
						<input
							value={form.tags}
							onChange={(event) =>
								setForm({ ...form, tags: event.target.value })
							}
						/>
					</label>
					<label className="gallery-field">
						<span>Description</span>
						<textarea
							value={form.description}
							onChange={(event) =>
								setForm({ ...form, description: event.target.value })
							}
						/>
					</label>
					<label className="gallery-field">
						<span>Review</span>
						<textarea
							value={form.review}
							onChange={(event) =>
								setForm({ ...form, review: event.target.value })
							}
						/>
					</label>
					<label className="gallery-field">
						<span>Thoughts</span>
						<textarea
							value={form.thoughts}
							onChange={(event) =>
								setForm({ ...form, thoughts: event.target.value })
							}
						/>
					</label>
				</section>
				<section className="detail-panel">
					<div className="detail-panel-heading">
						<h2>Custom fields</h2>
						<button
							aria-label="Add custom field"
							className="gallery-icon-button"
							type="button"
							onClick={() =>
								setCustomFieldState([
									...customFields,
									{ label: "", value: "", position: customFields.length },
								])
							}
						>
							<Plus size={16} />
						</button>
					</div>
					{customFields.map((field, index) => (
						<div className="custom-field-row" key={index}>
							<input
								aria-label="Custom field label"
								value={field.label}
								placeholder="Label"
								onChange={(event) => {
									const next = [...customFields];
									next[index] = { ...field, label: event.target.value };
									setCustomFieldState(next);
								}}
							/>
							<input
								aria-label="Custom field value"
								value={field.value}
								placeholder="Value"
								onChange={(event) => {
									const next = [...customFields];
									next[index] = { ...field, value: event.target.value };
									setCustomFieldState(next);
								}}
							/>
							<button
								aria-label="Remove custom field"
								className="gallery-icon-button"
								type="button"
								onClick={() =>
									setCustomFieldState(
										customFields.filter(
											(_, fieldIndex) => fieldIndex !== index,
										),
									)
								}
							>
								<Trash2 size={15} />
							</button>
						</div>
					))}
				</section>
			</aside>
		</div>
	);
}
