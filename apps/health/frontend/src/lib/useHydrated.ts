"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => undefined;

/** False during SSR and the hydration render, true afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}
