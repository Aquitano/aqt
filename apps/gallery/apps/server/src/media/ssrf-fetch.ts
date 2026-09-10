import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Shared SSRF-safe image fetching. Both the upload/import path and the
 * public-image serve cache reach arbitrary stored source URLs through the
 * server, so both must validate every hop against internal address ranges and
 * cap the buffered body. Kept in one place so the two paths can never drift.
 */

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Reject loopback, link-local (incl. the 169.254.169.254 cloud-metadata
 * endpoint), private, CGNAT, and reserved ranges so a server-side image fetch
 * can't be steered at internal infrastructure (SSRF). Defence-in-depth: a
 * resolve-then-fetch check still leaves a narrow DNS-rebinding window, but it
 * closes the practical vectors (literal IPs, internal DNS names, metadata IPs,
 * and redirect-to-internal hops).
 */
export function isBlockedAddress(ip: string): boolean {
	if (ip.includes(".")) {
		const parts = ip.split(".").map(Number);
		if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
		const [a = 0, b = 0] = parts;
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true; // link-local + cloud metadata
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		if (a >= 224) return true; // multicast + reserved
		return false;
	}
	const v6 = (ip.toLowerCase().split("%")[0] ?? "").trim();
	if (v6 === "::" || v6 === "::1") return true;
	if (v6.startsWith("fe80")) return true; // link-local
	if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique-local
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
	if (mapped?.[1]) return isBlockedAddress(mapped[1]);
	return false;
}

/** http(s) only, and every IP the host resolves to must be public. */
export async function assertFetchableUrl(raw: string): Promise<void> {
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported URL scheme: ${url.protocol}`);
	}
	const host = url.hostname.replace(/^\[|\]$/g, ""); // unwrap [ipv6]
	if (isIP(host)) {
		if (isBlockedAddress(host)) {
			throw new Error("URL resolves to a non-public address");
		}
		return;
	}
	const addresses = await lookup(host, { all: true });
	if (addresses.length === 0) throw new Error("Host did not resolve");
	for (const { address } of addresses) {
		if (isBlockedAddress(address)) {
			throw new Error("URL resolves to a non-public address");
		}
	}
}

/** One fetch attempt: validates the initial URL and every redirect hop against
 * SSRF before each request (redirects are followed manually so an internal
 * target can't be reached via a public-looking URL). */
export async function fetchFollowingRedirects(
	initialUrl: string,
	options: { userAgent: string; maxRedirects?: number },
): Promise<Response> {
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	let current = initialUrl;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		await assertFetchableUrl(current);
		const res = await fetch(current, {
			headers: { "User-Agent": options.userAgent },
			redirect: "manual",
		});
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) return res;
			await res.body?.cancel();
			current = new URL(location, current).toString();
			continue;
		}
		return res;
	}
	throw new Error("Too many redirects");
}

/** Buffers the body while enforcing the size cap up front (Content-Length) and
 * per-chunk, so a length-lying response can't be fully buffered before the
 * cap is enforced. Null if exceeded. */
export async function readImageBodyCapped(
	res: Response,
	maxBytes: number,
): Promise<Buffer | null> {
	const declared = res.headers.get("content-length");
	if (declared && Number(declared) > maxBytes) {
		await res.body?.cancel();
		return null;
	}
	const reader = res.body?.getReader();
	if (!reader) {
		const bytes = Buffer.from(await res.arrayBuffer());
		return bytes.byteLength > maxBytes ? null : bytes;
	}
	const chunks: Buffer[] = [];
	let total = 0;
	let read = await reader.read();
	while (!read.done) {
		total += read.value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(Buffer.from(read.value));
		read = await reader.read();
	}
	return Buffer.concat(chunks);
}
