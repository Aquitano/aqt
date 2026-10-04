export function moveEntry<T>(entries: T[], index: number, direction: number, visible: number) {
  const target = index + direction;
  if (target < 0 || target >= entries.length) return { entries, visible };
  const next = [...entries];
  [next[index], next[target]] = [next[target], next[index]];
  return { entries: next, visible: Math.max(visible, target + 1) };
}

export function appendEntry<T>(entries: T[], entry: T, visible: number) {
  const next = [...entries, entry];
  return { entries: next, visible: Math.max(visible, next.length) };
}
