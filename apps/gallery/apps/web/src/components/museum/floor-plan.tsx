import type { Rect, WorldLayout } from "@aqt/gallery-layout";
import { type MouseEvent, useMemo } from "react";

const PAD = 8;
const GOLD = "#cbb87f";
const BACKGROUND = "#0b0a09";

/** World (x, z) ↔ SVG (x, y) mapping for a floor plan fitted into a box.
 * Screen-x follows world-x and screen-y follows world-z: a top-down view with
 * the entrance (z = 0) at the top. */
export function planProjection(bounds: Rect, maxWidth: number, maxHeight: number) {
  const worldW = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const worldD = Math.max(bounds.maxZ - bounds.minZ, 1e-6);
  const scale = Math.min(maxWidth / worldW, maxHeight / worldD);
  return {
    scale,
    width: worldW * scale,
    height: worldD * scale,
    toSvg: (x: number, z: number) => ({
      x: (x - bounds.minX) * scale,
      y: (z - bounds.minZ) * scale,
    }),
    toWorld: (sx: number, sy: number) => ({
      x: sx / scale + bounds.minX,
      z: sy / scale + bounds.minZ,
    }),
  };
}

export type FloorPlanProps = {
  world: WorldLayout;
  activeRoom?: number;
  /** Heading marker; `angle` is the camera yaw (forward = (−sin θ, −cos θ)). */
  player?: { x: number; z: number; angle: number } | null;
  /** Click anywhere on the plan, in world coordinates. */
  onPick?: (x: number, z: number) => void;
  maxWidth?: number;
  maxHeight?: number;
  /** Number each room in visiting order (studio preview). */
  showRoomNumbers?: boolean;
  className?: string;
};

/** Presentational SVG floor plan: room footprints, door openings, painting
 * ticks and an optional player marker. Store-free so the studio can reuse it. */
export function FloorPlan({
  world,
  activeRoom,
  player,
  onPick,
  maxWidth = 128,
  maxHeight = 220,
  showRoomNumbers = false,
  className,
}: FloorPlanProps) {
  const plan = useMemo(
    () => planProjection(world.bounds, maxWidth, maxHeight),
    [world.bounds, maxWidth, maxHeight],
  );
  const viewW = plan.width + PAD * 2;
  const viewH = plan.height + PAD * 2;

  const handleClick = onPick
    ? (event: MouseEvent<SVGSVGElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        // The viewBox is inset by PAD on every side, so map the click into
        // viewBox space first, then back into the world.
        const sx = -PAD + ((event.clientX - rect.left) / rect.width) * viewW;
        const sy = -PAD + ((event.clientY - rect.top) / rect.height) * viewH;
        const at = plan.toWorld(sx, sy);
        onPick(at.x, at.z);
      }
    : undefined;

  // The player marker moves several times a second; everything under it is
  // fixed for a given world, so it is built once and reused across those
  // renders rather than reconciled each time.
  const rooms = useMemo(
    () =>
      world.rooms.map((room) => {
        const at = plan.toSvg(room.minX, room.minZ);
        const active = room.index === activeRoom;
        return (
          <rect
            key={room.id}
            x={at.x}
            y={at.y}
            width={room.width * plan.scale}
            height={room.depth * plan.scale}
            rx={2}
            fill={active ? "rgba(203,184,127,0.22)" : "rgba(255,255,255,0.05)"}
            stroke={active ? "rgba(203,184,127,0.7)" : "rgba(255,255,255,0.16)"}
            strokeWidth={1}
          />
        );
      }),
    [world.rooms, plan, activeRoom],
  );

  const doorways = useMemo(
    () =>
      world.doorways.map((door) => {
        const half = door.width / 2;
        const a =
          door.axis === "x" ? plan.toSvg(door.x - half, door.z) : plan.toSvg(door.x, door.z - half);
        const b =
          door.axis === "x" ? plan.toSvg(door.x + half, door.z) : plan.toSvg(door.x, door.z + half);
        return (
          <g key={`${door.rooms[0]}-${door.rooms[1]}`}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={BACKGROUND} strokeWidth={3} />
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={GOLD}
              strokeOpacity={0.8}
              strokeWidth={1.2}
            />
          </g>
        );
      }),
    [world.doorways, plan],
  );

  const numbers = useMemo(
    () =>
      showRoomNumbers
        ? world.rooms.map((room) => {
            const at = plan.toSvg(room.centerX, room.centerZ);
            return (
              <text
                key={room.id}
                x={at.x}
                y={at.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={Math.max(8, Math.min(12, room.depth * plan.scale * 0.35))}
                fill="rgba(233,217,173,0.75)"
              >
                {room.index + 1}
              </text>
            );
          })
        : null,
    [world.rooms, plan, showRoomNumbers],
  );

  // Keyed by placement, not artwork: the same work may hang in more than one
  // room, and two ticks sharing a key break reconciliation. A room holds any
  // given artwork at most once, so room + artwork identifies the placement.
  const ticks = useMemo(
    () =>
      world.paintings.map((painting) => {
        const at = plan.toSvg(painting.position[0], painting.position[2]);
        return (
          <circle
            key={`${painting.roomIndex}-${painting.artworkId}`}
            cx={at.x}
            cy={at.y}
            r={1.1}
            fill="rgba(233,217,173,0.6)"
          />
        );
      }),
    [world.paintings, plan],
  );

  const marker = player ? plan.toSvg(player.x, player.z) : null;
  const dirX = player ? -Math.sin(player.angle) : 0;
  const dirY = player ? -Math.cos(player.angle) : 0;

  return (
    // Pointer/touch teleport aid; keyboard users navigate by walking (WASD)
    <svg
      width={viewW}
      height={viewH}
      viewBox={`${-PAD} ${-PAD} ${viewW} ${viewH}`}
      className={className}
      onClick={handleClick}
      role="img"
      aria-label={onPick ? "Floor plan — click a room to teleport" : "Floor plan"}
    >
      <title>{onPick ? "Floor plan — click a room to teleport" : "Floor plan"}</title>
      {rooms}
      {doorways}
      {numbers}
      {ticks}
      {marker ? (
        <>
          <line
            x1={marker.x}
            y1={marker.y}
            x2={marker.x + dirX * 9}
            y2={marker.y + dirY * 9}
            stroke="#e9d9ad"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <circle
            cx={marker.x}
            cy={marker.y}
            r={3.2}
            fill="#e9d9ad"
            stroke={BACKGROUND}
            strokeWidth={1}
          />
        </>
      ) : null}
    </svg>
  );
}
