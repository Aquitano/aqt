import type { WorldLayout } from "@aqt/gallery-layout";
import * as THREE from "three";

import type { ArtworkData } from "../types";
import { LOADING_CANVAS_COLOR, MISSING_PLATE_COLOR } from "./constants";
import { imageLadder } from "./content";
import { roomWindow } from "./room-window";

/** Paintings within this many doorways of the player's room keep their
 * thumbnail resident; everything beyond it holds no texture at all. */
export const NEAR_ROOM_WINDOW = 2;
/** Distance (m) at which a painting upgrades to its mid image, with hysteresis
 * so pacing the boundary doesn't thrash the load. */
export const FULL_LOAD_ON = 14;
export const FULL_LOAD_OFF = 18;
/** Full images are requested only for the hovered / inspected work and stay
 * resident afterwards (re-hover is instant) until this many are held. */
export const MAX_RESIDENT_FULL = 3;
export const DEFAULT_BYTE_BUDGET = 256 * 1024 * 1024;
/** Once over budget, evict down to this fraction so a single new load doesn't
 * immediately tip the budget again. */
const BUDGET_RELEASE = 0.9;

export type StreamLevel = "thumb" | "mid" | "full";
const LEVELS: readonly StreamLevel[] = ["thumb", "mid", "full"];
const RANK = { thumb: 0, mid: 1, full: 2 } satisfies Record<StreamLevel, number>;

export type PlanPainting = {
  roomIndex: number;
  x: number;
  z: number;
  /** Levels with a distinct URL that has not failed, lowest first. */
  available: readonly StreamLevel[];
  /** Bytes held by each resident (decoded and applied) level. */
  resident: Partial<Record<StreamLevel, number>>;
  /** Levels currently being fetched. */
  loading: readonly StreamLevel[];
};

export type PlanInput = {
  paintings: readonly PlanPainting[];
  player: { x: number; z: number };
  nearRooms: ReadonlySet<number>;
  /** Hovered or inspected paintings: their textures are never evicted. */
  protectedIndices: ReadonlySet<number>;
  byteBudget: number;
};

export type StreamRequest = { index: number; level: StreamLevel };
export type StreamPlan = { load: StreamRequest[]; evict: StreamRequest[] };

function present(p: PlanPainting, level: StreamLevel): boolean {
  return p.resident[level] !== undefined || p.loading.includes(level);
}

type Ranked = { index: number; dist2: number };

/** Decide which texture levels to fetch and which to drop this tick. Pure so
 * the hysteresis, protection and budget rules can be tested without three. */
export function planTextureStreaming(input: PlanInput): StreamPlan {
  const { paintings, player, nearRooms, protectedIndices, byteBudget } = input;
  const ranked = paintings.map((p, index) => {
    const dx = player.x - p.x;
    const dz = player.z - p.z;
    return { p, index, dist2: dx * dx + dz * dz };
  });
  const load: (StreamRequest & Ranked)[] = [];
  const evict: StreamRequest[] = [];
  const wantFull: Ranked[] = [];
  const unprotectedFulls: Ranked[] = [];
  let fullCount = 0;

  for (const { p, index, dist2 } of ranked) {
    const base = p.available[0];
    if (!base) continue;
    const isProtected = protectedIndices.has(index);
    if (!isProtected && !nearRooms.has(p.roomIndex)) {
      for (const level of LEVELS) {
        if (present(p, level)) evict.push({ index, level });
      }
      continue;
    }
    // Counted after the far-room drop above, so the budget reflects the fulls
    // this plan keeps rather than ones it is already evicting.
    if (present(p, "full")) {
      fullCount++;
      if (!isProtected) unprotectedFulls.push({ index, dist2 });
    }
    if (!present(p, base)) load.push({ index, dist2, level: base });

    if (p.available.includes("mid") && base !== "mid") {
      const radius = present(p, "mid") ? FULL_LOAD_OFF : FULL_LOAD_ON;
      if (isProtected || dist2 <= radius * radius) {
        if (!present(p, "mid")) load.push({ index, dist2, level: "mid" });
      } else if (present(p, "mid")) {
        evict.push({ index, level: "mid" });
      }
    }
    if (isProtected && p.available.includes("full") && !present(p, "full")) {
      wantFull.push({ index, dist2 });
    }
  }

  unprotectedFulls.sort((a, b) => b.dist2 - a.dist2);
  for (const wanted of wantFull) {
    while (fullCount >= MAX_RESIDENT_FULL && unprotectedFulls.length > 0) {
      const victim = unprotectedFulls.shift();
      if (victim !== undefined) evict.push({ index: victim.index, level: "full" });
      fullCount--;
    }
    if (fullCount >= MAX_RESIDENT_FULL) break;
    load.push({ ...wanted, level: "full" });
    fullCount++;
  }
  while (fullCount > MAX_RESIDENT_FULL && unprotectedFulls.length > 0) {
    const victim = unprotectedFulls.shift();
    if (victim !== undefined) evict.push({ index: victim.index, level: "full" });
    fullCount--;
  }

  const evicted = new Set(evict.map((r) => `${r.index}:${r.level}`));
  let bytes = 0;
  const evictable: (StreamRequest & Ranked & { bytes: number })[] = [];
  for (const { p, index, dist2 } of ranked) {
    for (const level of LEVELS) {
      const size = p.resident[level];
      if (size === undefined || evicted.has(`${index}:${level}`)) continue;
      bytes += size;
      if (!protectedIndices.has(index)) evictable.push({ index, dist2, level, bytes: size });
    }
  }
  if (bytes > byteBudget) {
    evictable.sort((a, b) => b.dist2 - a.dist2 || RANK[b.level] - RANK[a.level]);
    const target = byteBudget * BUDGET_RELEASE;
    for (const entry of evictable) {
      if (bytes <= target) break;
      evict.push({ index: entry.index, level: entry.level });
      bytes -= entry.bytes;
    }
  }

  const gated = bytes >= byteBudget ? load.filter((r) => protectedIndices.has(r.index)) : load;
  gated.sort((a, b) => {
    const pa = protectedIndices.has(a.index) ? 0 : 1;
    const pb = protectedIndices.has(b.index) ? 0 : 1;
    return pa - pb || a.dist2 - b.dist2;
  });
  return { load: gated.map(({ index, level }) => ({ index, level })), evict };
}

export function estimateTextureBytes(width: number, height: number): number {
  return width * height * 4 * 1.33;
}

type Resident = { texture: THREE.Texture; bytes: number };

type LevelUrls = Partial<Record<StreamLevel, string>>;

/** One GPU texture per URL, shared by every painting that shows the same
 * image (a work hung twice) and released when the last one lets go. */
type SharedTexture = Resident & { refs: number };

type Entry = {
  index: number;
  urls: LevelUrls;
  failed: Set<StreamLevel>;
  resident: Map<StreamLevel, Resident>;
  /** Token per in-flight request so a late result for an evicted or
   * re-requested level is recognised and dropped. */
  loading: Map<StreamLevel, object>;
  applied: StreamLevel | null;
  missing: boolean;
};

export type StreamerView = {
  player: { x: number; z: number };
  roomIndex: number;
  /** Hovered placement, as an index into `world.paintings`. */
  hoveredIndex: number | null;
  /** Inspected placement while `inspectPhase !== "idle"`, else null. */
  inspectIndex: number | null;
};

export type TextureStreamerOptions = {
  world: WorldLayout;
  artworkById: Map<string, ArtworkData>;
  /** One canvas material per painting, indexed like `world.paintings`. */
  materials: readonly THREE.MeshStandardMaterial[];
  invalidate: () => void;
  /** Every image URL of this painting failed (or it never had one). */
  onMissing: (index: number) => void;
  byteBudget?: number;
};

function solidTexture(hex: string): THREE.DataTexture {
  const c = new THREE.Color(hex);
  const data = new Uint8Array([
    Math.round(c.r * 255),
    Math.round(c.g * 255),
    Math.round(c.b * 255),
    255,
  ]);
  const texture = new THREE.DataTexture(data, 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 1x1 placeholder maps. Every canvas material carries a `map` from the
 * start, so swapping in a streamed image changes a uniform, not the shader
 * program: no recompile stall the first time a texture lands. */
let placeholderTexture: THREE.DataTexture | null = null;
let missingTexture: THREE.DataTexture | null = null;
export function loadingCanvasTexture(): THREE.DataTexture {
  placeholderTexture ??= solidTexture(LOADING_CANVAS_COLOR);
  return placeholderTexture;
}
function missingPlateTexture(): THREE.DataTexture {
  missingTexture ??= solidTexture(MISSING_PLATE_COLOR);
  return missingTexture;
}

/** Distinct URLs per level, collapsing a level onto the lower one when they
 * share a URL (e.g. no mid variant yet, so mid === full). */
function distinctLadder(artwork: ArtworkData | undefined) {
  const urls: LevelUrls = {};
  if (!artwork) return urls;
  const ladder = imageLadder(artwork);
  if (ladder.thumb) urls.thumb = ladder.thumb;
  if (ladder.mid && ladder.mid !== ladder.thumb) urls.mid = ladder.mid;
  if (ladder.full && ladder.full !== ladder.mid && ladder.full !== ladder.thumb)
    urls.full = ladder.full;
  return urls;
}

/** Owns the lifetime of every streamed canvas texture: decodes off the main
 * thread via ImageBitmapLoader, applies the sharpest resident level to each
 * painting's material, and evicts per the planner. */
export class TextureStreamer {
  private readonly entries: Entry[];
  private readonly inFlight = new Map<string, Promise<ImageBitmap>>();
  private readonly shared = new Map<string, SharedTexture>();
  /** Images are served from the API origin, so the decode fetch is cross-origin
   * and `use-credentials` is what makes it carry the session cookie. Without it
   * an owner's unpublished work 404s in a private collection while the 2D view
   * (a plain <img>) renders it fine. Only unpublished work needs the cookie, so
   * if an edge cache ever fronts the API this wants scoping to private
   * exhibitions — a shared cache may skip a request that carries one, which
   * would waste the immutable year the server sets on published imagery. */
  private readonly loader = new THREE.ImageBitmapLoader()
    .setCrossOrigin("use-credentials")
    .setOptions({ imageOrientation: "flipY" });
  private readonly byteBudget: number;
  private disposed = false;

  constructor(private readonly opts: TextureStreamerOptions) {
    this.byteBudget = opts.byteBudget ?? DEFAULT_BYTE_BUDGET;
    this.entries = opts.world.paintings.map((p, index) => {
      return {
        index,
        urls: distinctLadder(opts.artworkById.get(p.artworkId)),
        failed: new Set(),
        resident: new Map(),
        loading: new Map(),
        applied: null,
        missing: false,
      };
    });
    for (const entry of this.entries) {
      if (this.available(entry).length === 0) this.markMissing(entry);
    }
  }

  tick(view: StreamerView) {
    if (this.disposed) return;
    const { world } = this.opts;
    const protectedIndices = new Set<number>();
    for (const index of [view.hoveredIndex, view.inspectIndex]) {
      if (index != null && index >= 0) protectedIndices.add(index);
    }
    const plan = planTextureStreaming({
      paintings: this.entries.map((entry) => {
        const p = world.paintings[entry.index];
        const resident: Partial<Record<StreamLevel, number>> = {};
        for (const [level, r] of entry.resident) resident[level] = r.bytes;
        return {
          roomIndex: p?.roomIndex ?? -1,
          x: p?.position[0] ?? 0,
          z: p?.position[2] ?? 0,
          available: this.available(entry),
          resident,
          loading: [...entry.loading.keys()],
        };
      }),
      player: view.player,
      nearRooms: new Set(roomWindow(world, view.roomIndex, NEAR_ROOM_WINDOW)),
      protectedIndices,
      byteBudget: this.byteBudget,
    });
    for (const r of plan.evict) {
      const entry = this.entries[r.index];
      if (entry) this.evict(entry, r.level);
    }
    for (const r of plan.load) {
      const entry = this.entries[r.index];
      if (entry) this.load(entry, r.level);
    }
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.entries) {
      entry.resident.clear();
      entry.loading.clear();
    }
    for (const shared of this.shared.values()) shared.texture.dispose();
    this.shared.clear();
    this.inFlight.clear();
  }

  private available(entry: Entry): StreamLevel[] {
    return LEVELS.filter((level) => entry.urls[level] !== undefined && !entry.failed.has(level));
  }

  private load(entry: Entry, level: StreamLevel) {
    const url = entry.urls[level];
    if (!url || entry.loading.has(level) || entry.resident.has(level)) return;
    const shared = this.shared.get(url);
    if (shared) {
      this.retain(entry, level, shared);
      return;
    }
    const token = {};
    entry.loading.set(level, token);
    let promise = this.inFlight.get(url);
    if (!promise) {
      promise = this.loader.loadAsync(url).finally(() => {
        this.inFlight.delete(url);
      });
      this.inFlight.set(url, promise);
    }
    promise.then(
      (bitmap) => {
        if (this.disposed || entry.loading.get(level) !== token) return;
        entry.loading.delete(level);
        let decoded = this.shared.get(url);
        if (!decoded) {
          decoded = {
            texture: this.createTexture(bitmap),
            bytes: estimateTextureBytes(bitmap.width, bitmap.height),
            refs: 0,
          };
          this.shared.set(url, decoded);
        }
        this.retain(entry, level, decoded);
      },
      () => {
        if (this.disposed || entry.loading.get(level) !== token) return;
        entry.loading.delete(level);
        entry.failed.add(level);
        if (this.available(entry).length === 0) this.markMissing(entry);
      },
    );
  }

  private createTexture(bitmap: ImageBitmap): THREE.Texture {
    const texture = new THREE.Texture(bitmap);
    // The bitmap was already flipped on decode.
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    // Once the pixels are on the GPU the decoded bitmap only costs memory
    // (the byte budget would otherwise be held twice, CPU and VRAM). An
    // evicted level is re-fetched from the HTTP cache, never re-uploaded from
    // this bitmap, so closing it is safe; the trade-off is that a WebGL
    // context loss leaves this texture blank until it is streamed again.
    texture.onUpdate = () => {
      texture.onUpdate = null;
      bitmap.close();
    };
    texture.needsUpdate = true;
    return texture;
  }

  private retain(entry: Entry, level: StreamLevel, shared: SharedTexture) {
    shared.refs++;
    entry.resident.set(level, { texture: shared.texture, bytes: shared.bytes });
    this.apply(entry);
  }

  private evict(entry: Entry, level: StreamLevel) {
    entry.loading.delete(level);
    const resident = entry.resident.get(level);
    if (!resident) return;
    entry.resident.delete(level);
    const url = entry.urls[level];
    const shared = url ? this.shared.get(url) : undefined;
    if (shared && --shared.refs <= 0) {
      shared.texture.dispose();
      if (url) this.shared.delete(url);
    }
    this.apply(entry);
  }

  /** Put the sharpest resident level on the canvas, falling back to the
   * placeholder (or the missing plate) when nothing is resident. */
  private apply(entry: Entry) {
    const material = this.opts.materials[entry.index];
    if (!material) return;
    let best: StreamLevel | null = null;
    for (const level of entry.resident.keys()) {
      if (best === null || RANK[level] > RANK[best]) best = level;
    }
    if (best === entry.applied && best !== null) return;
    entry.applied = best;
    const resident = best ? entry.resident.get(best) : undefined;
    material.map = resident
      ? resident.texture
      : entry.missing
        ? missingPlateTexture()
        : loadingCanvasTexture();
    material.roughness = resident ? 0.82 : 0.95;
    this.opts.invalidate();
  }

  private markMissing(entry: Entry) {
    if (entry.missing) return;
    entry.missing = true;
    this.apply(entry);
    this.opts.onMissing(entry.index);
  }
}
