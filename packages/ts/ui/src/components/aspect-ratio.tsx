import type { CSSVariables } from "@aqt/ui/lib/utils";
import { cn } from "cn";

function AspectRatio({
  ratio,
  className,
  style,
  ...props
}: React.ComponentProps<"div"> & { ratio: number }) {
  const ratioStyle: CSSVariables = { ...style, "--ratio": ratio };

  return (
    <div
      data-slot="aspect-ratio"
      style={ratioStyle}
      className={cn("relative aspect-(--ratio)", className)}
      {...props}
    />
  );
}

export { AspectRatio };
