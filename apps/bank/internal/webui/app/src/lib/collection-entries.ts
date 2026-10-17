export function moveEntry<T>(entries: T[], index: number, direction: number, visible: number) {
  const target = index + direction;
  const moving = entries[index];
  const displaced = entries[target];
  if (moving === undefined || displaced === undefined) return { entries, visible };
  return {
    entries: entries.with(index, displaced).with(target, moving),
    visible: Math.max(visible, target + 1),
  };
}

export function appendEntry<T>(entries: T[], entry: T, visible: number) {
  const next = [...entries, entry];
  const count = Math.max(1, visible);
  return { entries: next, visible: count, start: Math.max(0, next.length - count) };
}
