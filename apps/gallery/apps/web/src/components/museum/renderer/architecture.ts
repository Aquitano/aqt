import {
  DOOR_HEIGHT,
  type RoomLayout3D,
  WALL_THICKNESS,
  type WallId,
  type WorldLayout,
} from "@aqt/gallery-layout";
import type * as THREE from "three";

import { placement } from "./instanced";

const JAMB_WIDTH = 0.18;
const JAMB_DEPTH = WALL_THICKNESS + 0.12;
const LINTEL_HEIGHT = 0.22;
const COVE_INSET = WALL_THICKNESS / 2 + 0.06;
const COVE_DROP = 0.3;
const COVE_END_MARGIN = 1.6;
const BENCH_MIN_DEPTH = 10;
const LABEL_INSET = WALL_THICKNESS / 2 + 0.02;
/** Wall the room name hangs on: the first without a door, south preferred. */
const LABEL_WALL_ORDER: readonly WallId[] = ["south", "north", "west", "east"];

export type RoomLabelPlacement = {
  room: RoomLayout3D;
  position: [number, number, number];
  rotationY: number;
  maxWidth: number;
};

export type Architecture = {
  walls: THREE.Matrix4[];
  ceilings: THREE.Matrix4[];
  floors: THREE.Matrix4[];
  coves: THREE.Matrix4[];
  jambs: THREE.Matrix4[];
  lintels: THREE.Matrix4[];
  benchTops: THREE.Matrix4[];
  benchLegs: THREE.Matrix4[];
  roomLabels: RoomLabelPlacement[];
};

function roomLabel(room: RoomLayout3D): RoomLabelPlacement {
  const doorWalls = new Set(room.doors.map((d) => d.wall));
  const wall = LABEL_WALL_ORDER.find((w) => !doorWalls.has(w)) ?? "south";
  const y = Math.min(room.height - 0.85, DOOR_HEIGHT + 1.1);
  const alongX = Math.max(2, room.width - 4);
  const alongZ = Math.max(2, room.depth - 4);
  switch (wall) {
    case "south":
      return {
        room,
        position: [room.centerX, y, room.minZ + LABEL_INSET],
        rotationY: 0,
        maxWidth: alongX,
      };
    case "north":
      return {
        room,
        position: [room.centerX, y, room.maxZ - LABEL_INSET],
        rotationY: Math.PI,
        maxWidth: alongX,
      };
    case "west":
      return {
        room,
        position: [room.minX + LABEL_INSET, y, room.centerZ],
        rotationY: Math.PI / 2,
        maxWidth: alongZ,
      };
    case "east":
      return {
        room,
        position: [room.maxX - LABEL_INSET, y, room.centerZ],
        rotationY: -Math.PI / 2,
        maxWidth: alongZ,
      };
  }
}

/** Instance transforms for every static part of the museum, computed once
 * per world. Planes face +z before rotation: ceilings turn down, floors up. */
export function buildArchitecture(world: WorldLayout): Architecture {
  const out: Architecture = {
    walls: world.walls.map((b) => placement(...b.position, b.size[0], b.size[1], b.size[2])),
    ceilings: [],
    floors: [],
    coves: [],
    jambs: [],
    lintels: [],
    benchTops: [],
    benchLegs: [],
    roomLabels: [],
  };

  for (const room of world.rooms) {
    const { centerX: cx, centerZ: cz, width, depth, height } = room;
    out.ceilings.push(
      placement(cx, height, cz, width + WALL_THICKNESS, depth + WALL_THICKNESS, 1, Math.PI / 2),
    );
    out.floors.push(
      placement(cx, 0, cz, width + WALL_THICKNESS, depth + WALL_THICKNESS, 1, -Math.PI / 2),
    );

    const coveY = height - COVE_DROP;
    if (width >= depth) {
      const length = Math.max(0.5, width - COVE_END_MARGIN);
      for (const z of [room.minZ + COVE_INSET, room.maxZ - COVE_INSET]) {
        out.coves.push(placement(cx, coveY, z, length, 0.05, 0.05));
      }
    } else {
      const length = Math.max(0.5, depth - COVE_END_MARGIN);
      for (const x of [room.minX + COVE_INSET, room.maxX - COVE_INSET]) {
        out.coves.push(placement(x, coveY, cz, 0.05, 0.05, length));
      }
    }

    if (depth >= BENCH_MIN_DEPTH) {
      const rotY = depth > width ? Math.PI / 2 : 0;
      const cos = Math.cos(rotY);
      const sin = Math.sin(rotY);
      out.benchTops.push(placement(cx, 0.46, cz, 2.2, 0.12, 0.62, 0, rotY));
      for (const dx of [-0.9, 0.9]) {
        out.benchLegs.push(placement(cx + dx * cos, 0.2, cz - dx * sin, 0.1, 0.4, 0.5, 0, rotY));
      }
    }

    out.roomLabels.push(roomLabel(room));
  }

  for (const d of world.doorways) {
    const rotY = d.axis === "x" ? 0 : Math.PI / 2;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);
    const jambOffset = d.width / 2 + JAMB_WIDTH / 2 - 0.02;
    for (const side of [-1, 1]) {
      const o = side * jambOffset;
      out.jambs.push(
        placement(
          d.x + o * cos,
          d.height / 2,
          d.z - o * sin,
          JAMB_WIDTH,
          d.height,
          JAMB_DEPTH,
          0,
          rotY,
        ),
      );
    }
    out.lintels.push(
      placement(
        d.x,
        d.height + 0.07,
        d.z,
        d.width + JAMB_WIDTH * 2,
        LINTEL_HEIGHT,
        JAMB_DEPTH,
        0,
        rotY,
      ),
    );
  }

  return out;
}
