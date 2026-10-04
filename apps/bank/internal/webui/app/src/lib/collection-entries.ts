export function moveEntry<T>(entries: T[], index: number, direction: number, visible: number) {
  const target = index + direction;
  if (target < 0 || target >= entries.length) return { entries, visible };
  const next = [...entries];
  [next[index], next[target]] = [next[target], next[index]];
  return { entries: next, visible: Math.max(visible, target + 1) };
}

export function appendEntry<T>(entries: T[], entry: T, visible: number) {
  const next = [...entries, entry];
  const count = Math.max(1, visible);
  return { entries: next, visible: count, start: Math.max(0, next.length - count) };
}
