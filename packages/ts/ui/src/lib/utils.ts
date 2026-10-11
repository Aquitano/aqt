import type { CSSProperties } from "react";

export { cn } from "cn";

export type CSSVariables = CSSProperties & Partial<Record<`--${string}`, string | number>>;
