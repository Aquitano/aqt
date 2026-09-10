/**
 * One-call enriched import from public museum / knowledge APIs. Each source
 * is normalized to the artwork columns the gallery already stores — crucially
 * a `dimensions` string in "<h> × <w> cm" form, which the 3D layout engine
 * turns into a real-world canvas size instead of a guessed aspect ratio.
 *
 * Only the artwork *metadata* is fetched here, from a fixed allowlist of hosts
 * (so the agent never steers these requests). The image itself is handed to
 * the SSRF-guarded importMediaFromUrls downloader in upload.ts.
 */

export type MuseumSource = "met" | "artic" | "wikidata";

export type NormalizedArtist = {
  name: string;
  nationality: string | null;
  birthYear: number | null;
  deathYear: number | null;
};

export type NormalizedMuseumObject = {
  source: MuseumSource;
  objectId: string;
  title: string;
  artistName: string | null;
  year: string | null;
  medium: string | null;
  dimensions: string | null;
  description: string | null;
  sourceUrl: string | null;
  /** Remote image to download, or null when the object has no usable image. */
  imageUrl: string | null;
  /** Acquisition/credit line, surfaced as a custom field. */
  credit: string | null;
  artist: NormalizedArtist | null;
};

const USER_AGENT = "aqt-gallery/1.0 (museum metadata import)";
const META_TIMEOUT_MS = 12_000;

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`upstream returned HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Leading signed year in a date-ish string ("1840", "ca. 1450", "-100"). */
function leadingYear(value: unknown): number | null {
  const s = typeof value === "string" ? value : null;
  if (!s) return null;
  const match = s.match(/-?\d{1,4}/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function stripHtml(value: unknown): string | null {
  const s = typeof value === "string" ? value : null;
  if (!s) return null;
  const text = s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text ? text : null;
}

/** Trim a measurement to at most two decimals without trailing zeros. */
function trimNum(n: number): string {
  return Number.parseFloat(n.toFixed(2)).toString();
}

const guessableTypes = [
  ["painting", /oil|canvas|tempera|acrylic|watercolou?r|gouache|fresco|panel|\bpaint/],
  ["photo", /photograph|gelatin silver|albumen|daguerreotype|chromogenic/],
  ["sculpture", /bronze|marble|terracotta|sculpt|\bcast\b|plaster|carv/],
  ["print", /\bprint|etching|engraving|lithograph|woodcut|screenprint|aquatint|drypoint/],
] as const;

/** Best-effort artwork type from a medium string; "other" when unsure so the
 * agent (or curator) can correct it. */
export function guessArtworkType(
  medium: string | null,
): "painting" | "photo" | "sculpture" | "print" | "other" {
  const m = (medium ?? "").toLowerCase();
  for (const [type, pattern] of guessableTypes) {
    if (pattern.test(m)) return type;
  }
  return "other";
}

// ── The Met ─────────────────────────────────────────────────────────────────
async function fetchMet(objectId: string): Promise<NormalizedMuseumObject> {
  if (!/^\d+$/.test(objectId)) {
    throw new Error("Met objectId must be numeric (e.g. 436524)");
  }
  const data = asRecord(
    await fetchJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${objectId}`),
  );
  if (!data || data.message) {
    throw new Error(`Met object ${objectId} not found`);
  }
  const name = str(data.artistDisplayName);
  const image = str(data.primaryImage) ?? str(data.primaryImageSmall);
  return {
    source: "met",
    objectId,
    title: str(data.title) ?? "Untitled",
    artistName: name,
    year: str(data.objectDate),
    medium: str(data.medium),
    dimensions: str(data.dimensions),
    description: null,
    sourceUrl: str(data.objectURL) ?? `https://www.metmuseum.org/art/collection/search/${objectId}`,
    imageUrl: image,
    credit: str(data.creditLine),
    artist: name
      ? {
          name,
          nationality: str(data.artistNationality),
          birthYear: leadingYear(data.artistBeginDate),
          deathYear: leadingYear(data.artistEndDate),
        }
      : null,
  };
}

// ── Art Institute of Chicago ────────────────────────────────────────────────
const ARTIC_FIELDS =
  "id,title,artist_title,artist_display,date_display,medium_display,dimensions,image_id,description,credit_line";

/** Pull nationality + life dates out of ARTIC's free-text artist_display,
 * e.g. "Claude Monet\nFrench, 1840–1926". Conservative: only the clear
 * "<Nationality>, <YYYY>–<YYYY>" shape, else null. */
function parseArticArtist(name: string, display: unknown): NormalizedArtist {
  const text = typeof display === "string" ? display.replace(/\s+/g, " ") : "";
  const years = text.match(/(\d{4})\s*[–-]\s*(\d{4})/);
  const nat = text.match(/\b([A-Z][a-z]+)(?:,|\s+born|\s+\d{4})/);
  return {
    name,
    nationality: nat?.[1] ?? null,
    birthYear: years?.[1] ? Number.parseInt(years[1], 10) : null,
    deathYear: years?.[2] ? Number.parseInt(years[2], 10) : null,
  };
}

async function fetchArtic(objectId: string): Promise<NormalizedMuseumObject> {
  if (!/^\d+$/.test(objectId)) {
    throw new Error("Art Institute id must be numeric (e.g. 27992)");
  }
  const json = asRecord(
    await fetchJson(`https://api.artic.edu/api/v1/artworks/${objectId}?fields=${ARTIC_FIELDS}`),
  );
  const data = asRecord(json?.data);
  if (!data) {
    throw new Error(`Art Institute object ${objectId} not found`);
  }
  const config = asRecord(json?.config);
  const iiifBase = str(config?.iiif_url) ?? "https://www.artic.edu/iiif/2";
  const imageId = str(data.image_id);
  // 1686px keeps wall textures crisp while staying well under the import cap.
  const imageUrl = imageId ? `${iiifBase}/${imageId}/full/1686,/0/default.jpg` : null;
  const name = str(data.artist_title);
  return {
    source: "artic",
    objectId,
    title: str(data.title) ?? "Untitled",
    artistName: name,
    year: str(data.date_display),
    medium: str(data.medium_display),
    dimensions: str(data.dimensions),
    description: stripHtml(data.description),
    sourceUrl: `https://www.artic.edu/artworks/${objectId}`,
    imageUrl,
    credit: str(data.credit_line),
    artist: name ? parseArticArtist(name, data.artist_display) : null,
  };
}

// ── Wikidata ────────────────────────────────────────────────────────────────
type WdClaim = {
  mainsnak?: {
    datavalue?: { value?: unknown };
  };
};

function claimList(claims: unknown, prop: string): WdClaim[] {
  const rec = asRecord(claims);
  const list = rec?.[prop];
  return Array.isArray(list) ? (list as WdClaim[]) : [];
}

function firstValue(claims: unknown, prop: string): unknown {
  return claimList(claims, prop)[0]?.mainsnak?.datavalue?.value;
}

/** Entity-id reference value ({ id: "Q123" }). */
function entityId(value: unknown): string | null {
  const rec = asRecord(value);
  return typeof rec?.id === "string" ? rec.id : null;
}

function timeYear(value: unknown): number | null {
  const rec = asRecord(value);
  const time = typeof rec?.time === "string" ? rec.time : null;
  if (!time) return null;
  // "+1889-00-00T00:00:00Z" / "-0500-..." — keep the sign, drop padding zeros.
  const match = time.match(/^([+-])0*(\d+)-/);
  if (!match?.[2]) return null;
  const year = Number.parseInt(match[2], 10);
  return match[1] === "-" ? -year : year;
}

const CM_PER_UNIT: Record<string, number> = {
  Q174728: 1, // centimetre
  Q11573: 100, // metre
  Q174789: 0.1, // millimetre
  Q3710: 30.48, // foot
  Q218593: 2.54, // inch
};

function quantityCm(value: unknown): number | null {
  const rec = asRecord(value);
  const amount = typeof rec?.amount === "string" ? Number.parseFloat(rec.amount) : null;
  if (amount == null || !Number.isFinite(amount)) return null;
  const unitUrl = typeof rec?.unit === "string" ? rec.unit : "";
  const unitId = unitUrl.split("/").pop() ?? "";
  const factor = CM_PER_UNIT[unitId];
  if (!factor) return null;
  return amount * factor;
}

type WdEntity = { label: string | null; claims: unknown };

/** Batch label+claims lookup for referenced entities (creators, materials,
 * countries) the main entity only names by id. */
async function wdGetEntities(ids: string[]): Promise<Record<string, WdEntity>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return {};
  const json = asRecord(
    await fetchJson(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${unique.join(
        "|",
      )}&props=labels|claims&languages=en&format=json`,
    ),
  );
  const entities = asRecord(json?.entities);
  const out: Record<string, WdEntity> = {};
  if (!entities) return out;
  for (const id of unique) {
    const entity = asRecord(entities[id]);
    const labels = asRecord(entity?.labels);
    const en = asRecord(labels?.en);
    out[id] = {
      label: typeof en?.value === "string" ? en.value : null,
      claims: entity?.claims ?? null,
    };
  }
  return out;
}

function englishLabel(entity: Record<string, unknown> | null): string | null {
  const labels = asRecord(entity?.labels);
  const en = asRecord(labels?.en);
  if (typeof en?.value === "string") return en.value;
  // Fall back to any available label so a non-English entity still gets a title.
  if (labels) {
    for (const v of Object.values(labels)) {
      const rec = asRecord(v);
      if (typeof rec?.value === "string") return rec.value;
    }
  }
  return null;
}

async function fetchWikidata(objectId: string): Promise<NormalizedMuseumObject> {
  const qid = objectId.trim().toUpperCase();
  if (!/^Q\d+$/.test(qid)) {
    throw new Error("Wikidata id must look like Q12418");
  }
  const top = asRecord(
    await fetchJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`),
  );
  const entities = asRecord(top?.entities);
  const entity = asRecord(entities?.[qid]);
  if (!entity) {
    throw new Error(`Wikidata entity ${qid} not found`);
  }
  const claims = entity.claims;

  const height = quantityCm(firstValue(claims, "P2048"));
  const width = quantityCm(firstValue(claims, "P2049"));
  const dimensions =
    height != null && width != null ? `${trimNum(height)} × ${trimNum(width)} cm` : null;

  const file =
    typeof firstValue(claims, "P18") === "string" ? (firstValue(claims, "P18") as string) : null;
  const imageUrl = file
    ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=1600`
    : null;

  const creatorId = entityId(firstValue(claims, "P170"));
  const materialIds = claimList(claims, "P186")
    .map((c) => entityId(c.mainsnak?.datavalue?.value))
    .filter((id): id is string => Boolean(id));

  const refs = await wdGetEntities(
    [creatorId, ...materialIds].filter((id): id is string => Boolean(id)),
  );
  const medium =
    materialIds
      .map((id) => refs[id]?.label)
      .filter((label): label is string => Boolean(label))
      .join(", ") || null;

  let artist: NormalizedArtist | null = null;
  if (creatorId) {
    const creator = refs[creatorId];
    if (creator?.label) {
      const countryId = entityId(firstValue(creator.claims, "P27"));
      let nationality: string | null = null;
      if (countryId) {
        const country = refs[countryId] ?? (await wdGetEntities([countryId]))[countryId];
        nationality = country?.label ?? null;
      }
      artist = {
        name: creator.label,
        nationality,
        birthYear: timeYear(firstValue(creator.claims, "P569")),
        deathYear: timeYear(firstValue(creator.claims, "P570")),
      };
    }
  }

  const descriptions = asRecord(entity.descriptions);
  const enDesc = asRecord(descriptions?.en);
  return {
    source: "wikidata",
    objectId: qid,
    title: englishLabel(entity) ?? qid,
    artistName: artist?.name ?? null,
    year: timeYear(firstValue(claims, "P571"))?.toString() ?? null,
    medium,
    dimensions,
    description: typeof enDesc?.value === "string" ? enDesc.value : null,
    sourceUrl: `https://www.wikidata.org/wiki/${qid}`,
    imageUrl,
    credit: null,
    artist,
  };
}

/** Extract a { source, objectId } from a public object URL when the agent has
 * a link rather than ids. Returns null for an unrecognized host/shape. */
export function parseMuseumUrl(raw: string): { source: MuseumSource; objectId: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  if (host.endsWith("metmuseum.org")) {
    const m = url.pathname.match(/\/search\/(\d+)/) ?? url.pathname.match(/\/(\d+)\b/);
    return m?.[1] ? { source: "met", objectId: m[1] } : null;
  }
  if (host.endsWith("artic.edu")) {
    const m = url.pathname.match(/\/artworks\/(\d+)/);
    return m?.[1] ? { source: "artic", objectId: m[1] } : null;
  }
  if (host.endsWith("wikidata.org")) {
    const m = url.pathname.match(/(Q\d+)/i);
    return m?.[1] ? { source: "wikidata", objectId: m[1].toUpperCase() } : null;
  }
  return null;
}

export function fetchMuseumObject(
  source: MuseumSource,
  objectId: string,
): Promise<NormalizedMuseumObject> {
  const id = objectId.trim();
  switch (source) {
    case "met":
      return fetchMet(id);
    case "artic":
      return fetchArtic(id);
    case "wikidata":
      return fetchWikidata(id);
  }
}
