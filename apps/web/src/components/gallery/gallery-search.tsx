import { Focus, Search, Sparkles } from "lucide-react";

export function GallerySearch({
	value,
	onChange,
	placeholder = "Search archive...",
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	return (
		<label className="gallery-search" aria-label="Search gallery">
			<Search aria-hidden="true" size={18} />
			<input
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				type="search"
			/>
			<Focus aria-hidden="true" size={18} />
			<Sparkles aria-hidden="true" className="gallery-search-spark" size={18} />
		</label>
	);
}
