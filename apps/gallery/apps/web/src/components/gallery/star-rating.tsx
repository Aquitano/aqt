import { Star } from "lucide-react";
import { useState } from "react";

const STARS = [1, 2, 3, 4, 5] as const;

/** Five-star picker. Clicking the current value clears it. */
export function StarRating({
	value,
	onChange,
}: {
	value: number;
	onChange: (value: number) => void;
}) {
	const [hovered, setHovered] = useState(0);
	const shown = hovered || value;

	return (
		<div className="flex h-9 items-center gap-0.5">
			{STARS.map((star) => (
				<button
					key={star}
					type="button"
					aria-pressed={value === star}
					aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
					data-lit={star <= shown || undefined}
					className="rounded-md p-1 text-muted-foreground/35 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 data-lit:text-foreground"
					onMouseEnter={() => setHovered(star)}
					onMouseLeave={() => setHovered(0)}
					onClick={() => onChange(value === star ? 0 : star)}
				>
					<Star
						size={18}
						strokeWidth={1.75}
						className={star <= shown ? "fill-current" : undefined}
					/>
				</button>
			))}
		</div>
	);
}
