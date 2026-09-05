import { cn } from "@aqt-gallery/ui/lib/utils";
import type * as React from "react";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
	return (
		<kbd
			data-slot="kbd"
			className={cn(
				"pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-0.5 rounded-none border border-border bg-muted/60 px-1 font-medium font-sans text-[10px] text-muted-foreground leading-none",
				className,
			)}
			{...props}
		/>
	);
}

export { Kbd };
