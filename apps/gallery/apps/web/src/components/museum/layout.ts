/**
 * Pure layout engine: turns backend gallery content (rooms, placements,
 * artwork physical dimensions) into a walkable 3D world description —
 * wall geometry, collision boxes, painting transforms, light positions.
 *
 * Rooms are arranged as consecutive halls along +Z, connected by centered
 * doorways. Rooms with explicit `layout` metadata use it; rooms without
 * are sized procedurally from their artwork list.
 */
import type { ArtworkData, GalleryContent } from "./types";

export const WALL_THICKNESS = 0.36;
export const DOOR_WIDTH = 2.8;
export const DOOR_HEIGHT = 3.1;
export const EYE_HEIGHT = 1.7;
export const HANG_HEIGHT = 1.62;
export const PLAYER_RADIUS = 0.4;

export type WallId = "north" | "south" | "east" | "west";

export type Box = {
  position: [number, number, number];
  size: [number, number, number];
};

export type PaintingLayout = {
  artwork: ArtworkData;
  roomIndex: number;
  wall: WallId;
  /** Center of the canvas face. */
  position: [number, number, number];
  /** Rotation so the painting faces into the room. */
  rotationY: number;
  /** Canvas size in meters (height × width from real dimensions). */
  width: number;
  height: number;
  /** Inward normal of the wall the painting hangs on. */
  normal: [number, number, number];
};

export type RoomLayout3D = {
  index: number;
  id: string;
  name: string;
  description: string | null;
  width: number;
  depth: number;
  height: number;
  minZ: number;
  maxZ: number;
  center: [number, number];
};

export type Doorway = {
  z: number;
  height: number;
};

export type WorldLayout = {
  buildingWidth: number;
  totalDepth: number;
  maxHeight: number;
  rooms: RoomLayout3D[];
  walls: Box[];
  colliders: Box[];
  paintings: PaintingLayout[];
  doorways: Doorway[];
  spawn: [number, number, number];
};

/** Parse "73.7 × 92.1 cm" (height × width) into meters. */
export function parsePhysicalSize(
  dimensions: string | null | undefined,
): { height: number; width: number } | null {
  if (!dimensions) return null;
  const match = dimensions.match(/([\d.]+)\s*[×x]\s*([\d.]+)\s*cm/i);
  if (!match) return null;
  const h = Number.parseFloat(match[1]) / 100;
  const w = Number.parseFloat(match[2]) / 100;
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0) {
    return null;
  }
  return { height: h, width: w };
}

/** Display size in meters: real dimensions when parseable (scaled by
 * curatorial placement.scale), otherwise derived from image aspect. */
export function displaySize(artwork: ArtworkData): {
  width: number;
  height: number;
} {
  const scale = artwork.placement?.scale ?? 1;
  const physical = parsePhysicalSize(artwork.dimensions);
  if (physical) {
    return { width: physical.width * scale, height: physical.height * scale };
  }
  const aspect =
    artwork.imageWidth && artwork.imageHeight ? artwork.imageWidth / artwork.imageHeight : 4 / 3;
  const height = 1.2 * scale;
  return { width: height * aspect, height };
}

type Slot = { artwork: ArtworkData; width: number; height: number };

const FRAME_MARGIN = 1.5; // breathing room between paintings, meters
const MIN_SLOT = 2.6;

/** A procedurally-sized hall grows only this deep; a gallery with more
 * artworks than two walls can hold is split into several connected halls. */
const MAX_ROOM_DEPTH = 30;
const MIN_ROOM_DEPTH = 12;
/** Clearance between a room end and the nearest painting on a side wall. */
const WALL_END_MARGIN = 1.6;
/** Usable length of one side wall at maximum depth — the budget the
 * auto-splitter packs each wall up to before opening another hall. */
const MAX_SIDE_SPAN = MAX_ROOM_DEPTH - 2 * WALL_END_MARGIN;

function slotWidth(slot: Slot) {
  return Math.max(slot.width + FRAME_MARGIN, MIN_SLOT);
}

type RoomPlan = {
  id: string;
  name: string;
  description: string | null;
  width: number;
  depth: number;
  height: number;
  /** Wall id → slots, resolved (explicit walls honored, rest distributed). */
  wallSlots: Record<WallId, Slot[]>;
};

function planRoom(
  room: GalleryContent["rooms"][number],
  hasEntranceDoor: boolean,
  hasExitDoor: boolean,
): RoomPlan {
  const slots: Slot[] = room.artworks.map((artwork) => ({
    artwork,
    ...displaySize(artwork),
  }));

  const wallSlots: Record<WallId, Slot[]> = {
    north: [],
    south: [],
    east: [],
    west: [],
  };
  const unassigned: Slot[] = [];
  for (const slot of slots) {
    const wall = slot.artwork.placement?.wall as WallId | null | undefined;
    if (wall && wall in wallSlots) {
      wallSlots[wall].push(slot);
    } else {
      unassigned.push(slot);
    }
  }
  // Distribute unassigned artworks to the side walls, alternating, so
  // auto-generated rooms read as a classic two-sided gallery hall.
  for (const [i, slot] of unassigned.entries()) {
    wallSlots[i % 2 === 0 ? "east" : "west"].push(slot);
  }

  const explicit = room.layout ?? null;
  const sideNeed = Math.max(
    wallSlots.east.reduce((acc, s) => acc + slotWidth(s), 0),
    wallSlots.west.reduce((acc, s) => acc + slotWidth(s), 0),
  );
  const endNeed = Math.max(
    wallSlots.north.reduce((acc, s) => acc + slotWidth(s), 0) + (hasExitDoor ? DOOR_WIDTH + 1 : 0),
    wallSlots.south.reduce((acc, s) => acc + slotWidth(s), 0) +
      (hasEntranceDoor ? DOOR_WIDTH + 1 : 0),
  );

  const tallest = slots.reduce((acc, s) => Math.max(acc, s.height), 0);

  const depth = explicit?.depth ?? clamp(sideNeed + 4, MIN_ROOM_DEPTH, MAX_ROOM_DEPTH);
  const width = explicit?.width ?? clamp(Math.max(endNeed + 2, 13), 13, 24);
  const height = explicit?.height ?? clamp(Math.max(5, tallest + 2.6), 5, 7.5);

  return {
    id: room.id,
    name: room.name,
    description: room.description,
    width,
    depth,
    height,
    wallSlots,
  };
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

/** Spread slots along a free span [from, to]. Curated walls (any slot with
 * an explicit wallOffset) keep their pinned fractions; auto walls pack by
 * real slot width with equal gaps, so neighbours never overlap when they
 * fit and degrade gracefully to edge-to-edge only when over-packed. */
function spreadAlong(slots: Slot[], from: number, to: number): { slot: Slot; at: number }[] {
  if (slots.length === 0) return [];
  const span = to - from;

  const pinned = slots.some((s) => {
    const o = s.artwork.placement?.wallOffset;
    return o != null && o >= 0 && o <= 1;
  });
  if (pinned) {
    return slots.map((slot, i) => {
      const offset = slot.artwork.placement?.wallOffset;
      const t =
        offset != null && offset >= 0 && offset <= 1 ? offset : (i + 1) / (slots.length + 1);
      return { slot, at: from + t * span };
    });
  }

  const total = slots.reduce((acc, s) => acc + slotWidth(s), 0);
  const overflow = total > span;
  const gap = overflow ? 0 : (span - total) / (slots.length + 1);
  let cursor = overflow ? from + (span - total) / 2 : from + gap;
  return slots.map((slot) => {
    const w = slotWidth(slot);
    const at = cursor + w / 2;
    cursor += w + gap;
    return { slot, at };
  });
}

const WING_NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
function wingLabel(index: number) {
  return WING_NUMERALS[index] ?? String(index + 1);
}

/** Auto-distributed rooms (no curator wall assignments) grow only to
 * MAX_ROOM_DEPTH; a gallery with more artworks than two side walls can hold
 * is split into a sequence of connected halls so paintings never stack on
 * top of one another. Curated rooms — those with an explicit layout or any
 * per-artwork wall placement — are left exactly as authored. */
function splitToCapacity(room: GalleryContent["rooms"][number]): GalleryContent["rooms"] {
  const curated = room.layout != null || room.artworks.some((a) => a.placement?.wall != null);
  if (curated) return [room];

  const chunks: ArtworkData[][] = [];
  let current: ArtworkData[] = [];
  const walls = { east: 0, west: 0 };
  const reset = () => {
    walls.east = 0;
    walls.west = 0;
  };

  for (const artwork of room.artworks) {
    const width = slotWidth({ artwork, ...displaySize(artwork) });
    // Mirror planRoom's by-position alternating: even → east, odd → west.
    let target: "east" | "west" = current.length % 2 === 0 ? "east" : "west";
    if (current.length > 0 && walls[target] + width > MAX_SIDE_SPAN) {
      chunks.push(current);
      current = [];
      reset();
      target = "east";
    }
    walls[target] += width;
    current.push(artwork);
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length <= 1) return [room];

  return chunks.map((artworks, i) => ({
    ...room,
    id: i === 0 ? room.id : `${room.id}__wing-${i + 1}`,
    name: i === 0 ? room.name : `${room.name} · ${wingLabel(i)}`,
    description: i === 0 ? room.description : null,
    artworks,
  }));
}

export function buildWorldLayout(content: GalleryContent): WorldLayout {
  const roomsIn = content.rooms.filter((r) => r.artworks.length > 0).flatMap(splitToCapacity);

  const plans = roomsIn.map((room, i) => planRoom(room, i > 0, i < roomsIn.length - 1));

  const buildingWidth = plans.reduce((acc, p) => Math.max(acc, p.width), 13);
  const maxHeight = plans.reduce((acc, p) => Math.max(acc, p.height), 5);

  const walls: Box[] = [];
  const colliders: Box[] = [];
  const paintings: PaintingLayout[] = [];
  const rooms: RoomLayout3D[] = [];
  const doorways: Doorway[] = [];

  const addWall = (box: Box, collide = true) => {
    walls.push(box);
    if (collide) colliders.push(box);
  };

  const halfW = buildingWidth / 2;
  let z = 0;

  // Boundary wall builder: solid across the building, or with a centered
  // doorway (two segments + lintel above the opening).
  const boundaryWall = (atZ: number, height: number, withDoor: boolean) => {
    if (!withDoor) {
      addWall({
        position: [0, height / 2, atZ],
        size: [buildingWidth + WALL_THICKNESS, height, WALL_THICKNESS],
      });
      return;
    }
    const segW = (buildingWidth - DOOR_WIDTH) / 2;
    const segX = DOOR_WIDTH / 2 + segW / 2;
    addWall({
      position: [-segX, height / 2, atZ],
      size: [segW + WALL_THICKNESS / 2, height, WALL_THICKNESS],
    });
    addWall({
      position: [segX, height / 2, atZ],
      size: [segW + WALL_THICKNESS / 2, height, WALL_THICKNESS],
    });
    const lintelH = height - DOOR_HEIGHT;
    if (lintelH > 0.01) {
      addWall(
        {
          position: [0, DOOR_HEIGHT + lintelH / 2, atZ],
          size: [DOOR_WIDTH + 0.02, lintelH, WALL_THICKNESS],
        },
        false,
      );
    }
    doorways.push({ z: atZ, height });
  };

  for (const [i, plan] of plans.entries()) {
    const minZ = z;
    const maxZ = z + plan.depth;
    const heightHere = plan.height;
    const nextHeight = plans[i + 1]?.height ?? 0;

    if (i === 0) {
      boundaryWall(minZ, heightHere, false);
    }
    boundaryWall(maxZ, Math.max(heightHere, nextHeight), i < plans.length - 1);

    // Side walls for this room.
    addWall({
      position: [-halfW, heightHere / 2, (minZ + maxZ) / 2],
      size: [WALL_THICKNESS, heightHere, plan.depth + WALL_THICKNESS],
    });
    addWall({
      position: [halfW, heightHere / 2, (minZ + maxZ) / 2],
      size: [WALL_THICKNESS, heightHere, plan.depth + WALL_THICKNESS],
    });

    rooms.push({
      index: i,
      id: plan.id,
      name: plan.name,
      description: plan.description,
      width: buildingWidth,
      depth: plan.depth,
      height: heightHere,
      minZ,
      maxZ,
      center: [0, (minZ + maxZ) / 2],
    });

    // ---- Paintings ----
    const innerX = halfW - WALL_THICKNESS / 2;
    const margin = WALL_END_MARGIN;

    const place = (
      slot: Slot,
      wall: WallId,
      at: number, // coordinate along the wall (z for sides, x for ends)
    ) => {
      const y = Math.max(HANG_HEIGHT, slot.height / 2 + 0.55);
      let position: [number, number, number];
      let rotationY: number;
      let normal: [number, number, number];
      switch (wall) {
        case "east":
          position = [innerX, y, at];
          rotationY = -Math.PI / 2;
          normal = [-1, 0, 0];
          break;
        case "west":
          position = [-innerX, y, at];
          rotationY = Math.PI / 2;
          normal = [1, 0, 0];
          break;
        case "north":
          position = [at, y, maxZ - WALL_THICKNESS / 2];
          rotationY = Math.PI;
          normal = [0, 0, -1];
          break;
        case "south":
          position = [at, y, minZ + WALL_THICKNESS / 2];
          rotationY = 0;
          normal = [0, 0, 1];
          break;
      }
      paintings.push({
        artwork: slot.artwork,
        roomIndex: i,
        wall,
        position,
        rotationY,
        width: slot.width,
        height: slot.height,
        normal,
      });
    };

    for (const { slot, at } of spreadAlong(plan.wallSlots.east, minZ + margin, maxZ - margin)) {
      place(slot, "east", at);
    }
    for (const { slot, at } of spreadAlong(plan.wallSlots.west, minZ + margin, maxZ - margin)) {
      place(slot, "west", at);
    }

    // End walls: split around the doorway when one exists.
    const endWall = (wall: "north" | "south", slots: Slot[]) => {
      if (slots.length === 0) return;
      const hasDoor = wall === "north" ? i < plans.length - 1 : i > 0;
      if (!hasDoor) {
        for (const { slot, at } of spreadAlong(slots, -halfW + margin, halfW - margin)) {
          place(slot, wall, at);
        }
        return;
      }
      const left: Slot[] = [];
      const right: Slot[] = [];
      for (const [j, s] of slots.entries()) {
        (j % 2 === 0 ? left : right).push(s);
      }
      for (const { slot, at } of spreadAlong(left, -halfW + margin, -DOOR_WIDTH / 2 - 0.8)) {
        place(slot, wall, at);
      }
      for (const { slot, at } of spreadAlong(right, DOOR_WIDTH / 2 + 0.8, halfW - margin)) {
        place(slot, wall, at);
      }
    };
    endWall("north", plan.wallSlots.north);
    endWall("south", plan.wallSlots.south);

    z = maxZ;
  }

  return {
    buildingWidth,
    totalDepth: z,
    maxHeight,
    rooms,
    walls,
    colliders,
    paintings,
    doorways,
    spawn: [0, EYE_HEIGHT, Math.min(3.2, (rooms[0]?.depth ?? 8) / 2)],
  };
}

/** Axis-separated AABB collision: returns the allowed new position. */
export function collideAndSlide(
  from: { x: number; z: number },
  to: { x: number; z: number },
  colliders: Box[],
): { x: number; z: number } {
  const r = PLAYER_RADIUS;
  const blocked = (x: number, z: number) =>
    colliders.some((c) => {
      const [cx, , cz] = c.position;
      const [sx, , sz] = c.size;
      return Math.abs(x - cx) < sx / 2 + r && Math.abs(z - cz) < sz / 2 + r;
    });
  const x = blocked(to.x, from.z) ? from.x : to.x;
  const z = blocked(x, to.z) ? from.z : to.z;
  return { x, z };
}
