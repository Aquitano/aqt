import * as THREE from "three";

import {
  MISSING_LABEL_COLOR,
  PLAQUE_SUBTITLE_COLOR,
  PLAQUE_TEXT_HEIGHT,
  PLAQUE_TEXT_WIDTH,
  PLAQUE_TITLE_COLOR,
  ROOM_LABEL_COLOR,
} from "./constants";

const FONT = `"Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif`;

export const PLAQUE_TILE_WIDTH = 256;
export const PLAQUE_TILE_HEIGHT = 128;
export const PLAQUE_COLUMNS = 8;
const MAX_CANVAS_SIZE = 4096;
export const PLAQUES_PER_PAGE = PLAQUE_COLUMNS * (MAX_CANVAS_SIZE / PLAQUE_TILE_HEIGHT);

export type BakedText = { texture: THREE.CanvasTexture; aspect: number };
export type PlaqueLabel = { title: string; subtitle: string };
export type PlaqueTile = {
  page: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
};
export type PlaqueAtlas = {
  textures: THREE.CanvasTexture[];
  tiles: PlaqueTile[];
};

function context2d(width: number, height: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d");
}

function textTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) {
    t = t.slice(0, -1).trimEnd();
  }
  return `${t}…`;
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const candidate = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) {
        const last = lines.pop() ?? "";
        lines.push(ellipsize(ctx, `${last} ${words.slice(i).join(" ")}`, maxWidth));
        return lines;
      }
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(ellipsize(ctx, current, maxWidth));
  return lines;
}

const TITLE_LINE = 26;
const SUBTITLE_LINE = 22;
const SUBTITLE_GAP = 6;

function drawPlaqueTile(ctx: CanvasRenderingContext2D, x0: number, y0: number, label: PlaqueLabel) {
  const maxWidth = PLAQUE_TILE_WIDTH - 24;
  const cx = x0 + PLAQUE_TILE_WIDTH / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 22px ${FONT}`;
  const titleLines = wrapLines(ctx, label.title, maxWidth, 2);
  ctx.font = `400 17px ${FONT}`;
  const subtitle = label.subtitle ? ellipsize(ctx, label.subtitle, maxWidth) : "";
  const blockHeight =
    titleLines.length * TITLE_LINE + (subtitle ? SUBTITLE_GAP + SUBTITLE_LINE : 0);
  let y = y0 + (PLAQUE_TILE_HEIGHT - blockHeight) / 2;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillStyle = PLAQUE_TITLE_COLOR;
  for (const line of titleLines) {
    ctx.fillText(line, cx, y + TITLE_LINE / 2);
    y += TITLE_LINE;
  }
  if (subtitle) {
    y += SUBTITLE_GAP;
    ctx.font = `400 17px ${FONT}`;
    ctx.fillStyle = PLAQUE_SUBTITLE_COLOR;
    ctx.fillText(subtitle, cx, y + SUBTITLE_LINE / 2);
  }
}

/** Rasterize every plaque into as few atlas pages as possible (8 columns of
 * 256x128 tiles, up to 4096 px tall) and return each label's UV rect. */
export function buildPlaqueAtlas(labels: readonly PlaqueLabel[]): PlaqueAtlas | null {
  if (typeof document === "undefined" || labels.length === 0) return null;
  const textures: THREE.CanvasTexture[] = [];
  const tiles: PlaqueTile[] = [];
  const pageCount = Math.ceil(labels.length / PLAQUES_PER_PAGE);
  for (let page = 0; page < pageCount; page++) {
    const pageLabels = labels.slice(page * PLAQUES_PER_PAGE, (page + 1) * PLAQUES_PER_PAGE);
    const rows = Math.ceil(pageLabels.length / PLAQUE_COLUMNS);
    const width = PLAQUE_COLUMNS * PLAQUE_TILE_WIDTH;
    const height = rows * PLAQUE_TILE_HEIGHT;
    const ctx = context2d(width, height);
    if (!ctx) return null;
    pageLabels.forEach((label, i) => {
      const col = i % PLAQUE_COLUMNS;
      const row = Math.floor(i / PLAQUE_COLUMNS);
      const x0 = col * PLAQUE_TILE_WIDTH;
      const y0 = row * PLAQUE_TILE_HEIGHT;
      drawPlaqueTile(ctx, x0, y0, label);
      tiles.push({
        page,
        u0: x0 / width,
        u1: (x0 + PLAQUE_TILE_WIDTH) / width,
        v0: 1 - y0 / height,
        v1: 1 - (y0 + PLAQUE_TILE_HEIGHT) / height,
      });
    });
    textures.push(textTexture(ctx.canvas));
  }
  return { textures, tiles };
}

/** One merged quad geometry per atlas page: all plaque text in a single draw
 * call. `transforms[i]` places plaque i's text centre in world space. */
export function buildPlaqueTextGeometries(
  atlas: PlaqueAtlas,
  transforms: readonly THREE.Matrix4[],
): THREE.BufferGeometry[] {
  const corner = new THREE.Vector3();
  const hw = PLAQUE_TEXT_WIDTH / 2;
  const hh = PLAQUE_TEXT_HEIGHT / 2;
  return atlas.textures.map((_, page) => {
    const indices = atlas.tiles
      .map((tile, i) => (tile.page === page ? i : -1))
      .filter((i) => i >= 0);
    const positions = new Float32Array(indices.length * 12);
    const uvs = new Float32Array(indices.length * 8);
    const index = new Uint32Array(indices.length * 6);
    indices.forEach((plaque, q) => {
      const tile = atlas.tiles[plaque];
      const transform = transforms[plaque];
      if (!tile || !transform) return;
      const corners: [number, number, number, number][] = [
        [-hw, -hh, tile.u0, tile.v1],
        [hw, -hh, tile.u1, tile.v1],
        [hw, hh, tile.u1, tile.v0],
        [-hw, hh, tile.u0, tile.v0],
      ];
      corners.forEach(([x, y, u, v], c) => {
        corner.set(x, y, 0).applyMatrix4(transform);
        positions.set([corner.x, corner.y, corner.z], (q * 4 + c) * 3);
        uvs.set([u, v], (q * 4 + c) * 2);
      });
      const b = q * 4;
      index.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.computeBoundingSphere();
    return geometry;
  });
}

const ROOM_LABEL_FONT_PX = 84;
const ROOM_LABEL_HEIGHT_PX = 128;
const ROOM_LABEL_MAX_WIDTH_PX = 2400;

/** Room name, uppercase and letter-spaced, on a canvas trimmed to the text so
 * the quad it maps onto carries no dead transparent area. */
export function bakeRoomLabel(name: string): BakedText | null {
  const text = name.toUpperCase();
  const measure = context2d(1, 1);
  if (!measure) return null;
  let px = ROOM_LABEL_FONT_PX;
  let spacing = px * 0.24;
  let width = 0;
  const chars = Array.from(text);
  const advance = (ctx: CanvasRenderingContext2D) =>
    chars.reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) +
    spacing * Math.max(0, chars.length - 1);
  for (;;) {
    measure.font = `600 ${px}px ${FONT}`;
    width = advance(measure);
    if (width <= ROOM_LABEL_MAX_WIDTH_PX || px <= 24) break;
    px -= 4;
    spacing = px * 0.24;
  }
  const pad = 16;
  const canvasWidth = Math.ceil(width + pad * 2);
  const ctx = context2d(canvasWidth, ROOM_LABEL_HEIGHT_PX);
  if (!ctx) return null;
  ctx.font = `600 ${px}px ${FONT}`;
  ctx.fillStyle = ROOM_LABEL_COLOR;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let x = pad;
  for (const ch of chars) {
    ctx.fillText(ch, x, ROOM_LABEL_HEIGHT_PX / 2);
    x += ctx.measureText(ch).width + spacing;
  }
  return {
    texture: textTexture(ctx.canvas),
    aspect: canvasWidth / ROOM_LABEL_HEIGHT_PX,
  };
}

const MISSING_FONT_PX = 40;
const MISSING_LINE_PX = 50;
const MISSING_MAX_WIDTH_PX = 600;

/** "Title / image unavailable" for a canvas whose every image URL failed. */
export function bakeMissingLabel(title: string): BakedText | null {
  const measure = context2d(1, 1);
  if (!measure) return null;
  measure.font = `600 ${MISSING_FONT_PX}px ${FONT}`;
  const lines = [...wrapLines(measure, title, MISSING_MAX_WIDTH_PX, 3), "— image unavailable —"];
  const pad = 12;
  const width = Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width)) + pad * 2);
  const height = lines.length * MISSING_LINE_PX + pad * 2;
  const ctx = context2d(width, height);
  if (!ctx) return null;
  ctx.font = `600 ${MISSING_FONT_PX}px ${FONT}`;
  ctx.fillStyle = MISSING_LABEL_COLOR;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, pad + MISSING_LINE_PX * (i + 0.5));
  });
  return { texture: textTexture(ctx.canvas), aspect: width / height };
}
