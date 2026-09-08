export function element<T extends Element>(id: string, kind: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof kind)) throw new Error(`#${id} is not a ${kind.name}`);
  return found;
}
