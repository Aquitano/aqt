import { useEffect, useState } from "react";

/** Returns `value` delayed by `delayMs`, so a value driven by fast input (e.g.
 * a search box) can feed a query key without firing a request per keystroke.
 * The latest value always wins; intermediate values are dropped. */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
