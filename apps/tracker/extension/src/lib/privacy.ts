export function isPrivateHost(hostname: string, privateHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return privateHosts.some((entry) => {
    const base = entry.trim().toLowerCase().replace(/^\*\./, "");
    return base !== "" && (host === base || host.endsWith(`.${base}`));
  });
}

export function privateUrl(url: URL): string {
  return `https://${url.hostname}/`;
}
