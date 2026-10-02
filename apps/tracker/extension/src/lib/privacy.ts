export function isPrivateHost(hostname: string, privateHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return privateHosts.some((entry) => {
    const base = entryHost(entry);
    return base !== "" && (host === base || host.endsWith(`.${base}`));
  });
}

// People paste what the address bar shows: a scheme, a port, a path, a
// Unicode name. The browser reports hostnames bare and in Punycode.
function entryHost(entry: string): string {
  const bare = entry.trim().replace(/^\*\./, "");
  if (bare === "") return "";
  return URL.parse(bare.includes("://") ? bare : `https://${bare}`)?.hostname ?? bare.toLowerCase();
}

export function privateUrl(url: URL): string {
  return `https://${url.hostname}/`;
}

export type ForgetTarget = { url: string } | { host: string };

// A page is its URL without the fragment; a host covers its subdomains, as
// in the private-host list.
export function forgets(target: ForgetTarget): (url: string) => boolean {
  if ("host" in target) {
    return (url) => {
      const host = URL.parse(url)?.hostname;
      return host !== undefined && isPrivateHost(host, [target.host]);
    };
  }
  const page = withoutFragment(target.url);
  return (url) => withoutFragment(url) === page;
}

function withoutFragment(url: string): string {
  return url.split("#", 1)[0] ?? url;
}
