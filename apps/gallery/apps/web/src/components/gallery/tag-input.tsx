import { X } from "lucide-react";
import { useState } from "react";

/** Chips plus a text field. Enter or a comma commits the draft, Backspace on
 * an empty draft pops the last chip, blur commits whatever is pending. */
export function TagInput({
	id,
	value,
	onChange,
	placeholder,
}: {
	id?: string;
	value: string[];
	onChange: (tags: string[]) => void;
	placeholder?: string;
}) {
	const [draft, setDraft] = useState("");

	const commit = () => {
		const next = draft.replace(/,/g, "").trim();
		setDraft("");
		if (!next) return;
		const exists = value.some(
			(tag) => tag.toLowerCase() === next.toLowerCase(),
		);
		if (!exists) onChange([...value, next]);
	};

	return (
		<label className="flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-input px-2 py-1.5 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 dark:bg-input/20">
			{value.map((tag) => (
				<span
					key={tag}
					className="inline-flex items-center gap-0.5 rounded-full bg-secondary py-0.5 pr-1 pl-2.5 text-[12.5px] text-secondary-foreground"
				>
					{tag}
					<button
						type="button"
						aria-label={`Remove ${tag}`}
						className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
						onClick={() => onChange(value.filter((entry) => entry !== tag))}
					>
						<X size={12} />
					</button>
				</span>
			))}
			<input
				id={id}
				value={draft}
				placeholder={value.length === 0 ? placeholder : undefined}
				className="h-6 min-w-28 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === ",") {
						event.preventDefault();
						commit();
					} else if (
						event.key === "Backspace" &&
						draft === "" &&
						value.length > 0
					) {
						onChange(value.slice(0, -1));
					}
				}}
			/>
		</label>
	);
}
