import type { HostEnv, SourceRoot } from "@aqt/turnstash-core";

export const joinFrom = (host: HostEnv, base: string, ...segments: ReadonlyArray<string>): string =>
  [base.replace(/[\\/]+$/, ""), ...segments].join(host.os === "win32" ? "\\" : "/");

export const distinctRoots = (roots: ReadonlyArray<SourceRoot>): ReadonlyArray<SourceRoot> => {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const normalized = root.path.replaceAll("\\", "/").replace(/\/+$/, "");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};
