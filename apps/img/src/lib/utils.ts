import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * React accepts custom properties in `style`, but its own `CSSProperties` lists
 * only the known CSS properties, so declaring them keeps the `--var` styles
 * components pass to Radix and sonner typed instead of cast.
 */
declare module "react" {
  interface CSSProperties {
    [variable: `--${string}`]: string | number | undefined;
  }
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
