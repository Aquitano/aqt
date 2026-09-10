import {
  collideAndSlide,
  doorwayWaypoints,
  EYE_HEIGHT,
  type PaintingLayout,
  PLAYER_RADIUS,
  pickPaintingRay,
  type RoomLayout3D,
  roomIndexAt,
  WALL_THICKNESS,
  type WorldLayout,
} from "@aqt/gallery-layout";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { type InspectPhase, type MuseumController, useMuseumStore } from "../store";

const WALK_SPEED = 3.4;
const SPRINT_SPEED = 5.4;
const VELOCITY_DAMP = 10;
const LOOK_SENS = 0.0025;
const PITCH_LIMIT = 1.45;
const MAX_DELTA = 0.05;
const FRAME_MS = 1000 / 60;
const PUBLISH_INTERVAL = 0.08;
const HOVER_INTERVAL = 0.06;
const PICK_RANGE = 7;
const PICK_PAD = 0.16;
/** A phone player taps a painting from across the room rather than walking the
 * crosshair onto it, so the tap reaches far further than the crosshair pick.
 * Walls, not range, are what bound it. */
const TAP_RANGE = 80;

const INSPECT_SECONDS = 0.95;
/** Inspect framing leaves the right of the viewport to the info panel. */
const INSPECT_FIT = { fitH: 0.52, fitV: 0.78, side: 0.16 };
/** Centered framing (no side panel), a touch fuller than the inspect view. */
const TOUR_FIT = { fitH: 0.62, fitV: 0.74, side: 0 };

/** Guided-tour tuning. Cruise speed sets the glide pace; the duration of each
 * leg is the path length at that speed, eased and clamped so a short hop never
 * snaps and a long room-to-room walk never drags. The camera faces its travel
 * direction until within TOUR_APPROACH of the painting, then turns to it. */
const TOUR_CRUISE = 2.6;
const TOUR_MIN_GLIDE = 1.1;
const TOUR_MAX_GLIDE = 5.5;
const TOUR_DWELL = 4.5;
const TOUR_LOOKAHEAD = 3;
const TOUR_APPROACH = 3.2;
const TOUR_TURN_DAMP = 4.5;

/** Touch-look sensitivity (radians per pixel dragged) and the limits that
 * separate a tap (inspect) from a look drag. */
const TOUCH_LOOK_SENS = 0.0042;
const TAP_MOVE_PX = 10;
const TAP_MS = 350;

const UP = new THREE.Vector3(0, 1, 0);
const WALK_INSET = WALL_THICKNESS + PLAYER_RADIUS;

type ViewFit = { fitH: number; fitV: number; side: number };

type Pose = { position: THREE.Vector3; quaternion: THREE.Quaternion };

const newPose = (): Pose => ({
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
});

type InspectState = {
  phase: InspectPhase;
  painting: PaintingLayout | null;
  /** Index of `painting` in `world.paintings`, or -1. */
  index: number;
  t: number;
  from: Pose;
  to: Pose;
};

type TourGlide = {
  index: number;
  phase: "glide" | "dwell";
  t: number;
  duration: number;
  dwell: number;
  path: THREE.Vector3[];
  segLens: number[];
  total: number;
  finalQuat: THREE.Quaternion;
};

type TourState = {
  active: boolean;
  paused: boolean;
  index: number;
  glide: TourGlide | null;
};

type LookTouch = {
  id: number;
  lastX: number;
  lastY: number;
  startX: number;
  startY: number;
  startMs: number;
  moved: boolean;
};

/** Free-look pose for the dev harness: the rig behaves as if walking without
 * a pointer lock, so headless screenshots render the lit scene. Unset fields
 * fall back to the world spawn. */
export type AutopilotPose = {
  x?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
};

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Point at arc length `s` along a polyline, written into `out`. */
function samplePath(
  path: THREE.Vector3[],
  segLens: number[],
  total: number,
  s: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) return out;
  if (path.length === 1 || s <= 0) return out.copy(first);
  if (s >= total) return out.copy(last);
  let acc = 0;
  for (let i = 0; i < segLens.length; i++) {
    const len = segLens[i] ?? 0;
    const a = path[i];
    const b = path[i + 1];
    if (acc + len >= s && a && b) {
      return out.copy(a).lerp(b, len > 0 ? (s - acc) / len : 1);
    }
    acc += len;
  }
  return out.copy(last);
}

function clampIntoRoom(room: RoomLayout3D, x: number, z: number) {
  return {
    x: THREE.MathUtils.clamp(x, room.minX + WALK_INSET, room.maxX - WALK_INSET),
    z: THREE.MathUtils.clamp(z, room.minZ + WALK_INSET, room.maxZ - WALK_INSET),
  };
}

/** Room whose footprint contains the point, else the one whose footprint is
 * nearest (a minimap click can land in a wall or the padding). */
function nearestRoomIndex(world: WorldLayout, x: number, z: number): number {
  const inside = roomIndexAt(world, x, z);
  if (inside !== -1) return inside;
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const room of world.rooms) {
    const dx = Math.max(room.minX - x, 0, x - room.maxX);
    const dz = Math.max(room.minZ - z, 0, z - room.maxZ);
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = room.index;
    }
  }
  return best;
}

export function PlayerRig({ world, autopilot }: { world: WorldLayout; autopilot?: AutopilotPose }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const isTouch = useMuseumStore((s) => s.isTouch);

  const keys = useRef<Record<string, boolean>>({});
  const move = useRef({ x: 0, y: 0 });
  const look = useRef({ yaw: world.spawnYaw, pitch: 0 });
  const lookTouch = useRef<LookTouch | null>(null);
  /** Pointer lock held (desktop), touch-walking engaged, or autopilot. */
  const walking = useRef(false);
  const roomIndex = useRef(0);
  const hoveredIndex = useRef(-1);
  const hoverAcc = useRef(0);
  const publishAcc = useRef(0);
  const lastFrameAt = useRef(0);
  const frameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inspect = useRef<InspectState>({
    phase: "idle",
    painting: null,
    index: -1,
    t: 0,
    from: newPose(),
    to: newPose(),
  });
  const tour = useRef<TourState>({
    active: false,
    paused: false,
    index: 0,
    glide: null,
  });

  const scratch = useMemo(
    () => ({
      velocity: new THREE.Vector2(),
      input: new THREE.Vector2(),
      target: new THREE.Vector2(),
      euler: new THREE.Euler(0, 0, 0, "YXZ"),
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      p: new THREE.Vector3(),
      n: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      ahead: new THREE.Vector3(),
      lookAt: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      mat: new THREE.Matrix4(),
    }),
    [],
  );

  /** Hover raycast candidates per room: the room's own paintings plus those
   * of every room reachable through one of its doors. */
  const hoverCandidates = useMemo(
    () =>
      world.rooms.map((room) => {
        const rooms = new Set<number>([room.index]);
        for (const door of room.doors) rooms.add(door.toRoom);
        const out: number[] = [];
        for (const r of rooms) out.push(...(world.paintingsByRoom[r] ?? []));
        return out;
      }),
    [world],
  );
  const allPaintings = useMemo(() => world.paintings.map((_, i) => i), [world]);

  const applyLook = () => {
    camera.quaternion.setFromEuler(
      scratch.euler.set(look.current.pitch, look.current.yaw, 0, "YXZ"),
    );
  };

  const syncLookFromCamera = () => {
    const e = scratch.euler.setFromQuaternion(camera.quaternion, "YXZ");
    look.current.yaw = e.y;
    look.current.pitch = e.x;
  };

  const setWalking = (value: boolean) => {
    walking.current = value;
    useMuseumStore.getState().setLocked(value);
  };

  const setHover = (paintingIndex: number) => {
    if (hoveredIndex.current === paintingIndex) return;
    hoveredIndex.current = paintingIndex;
    const painting = world.paintings[paintingIndex];
    useMuseumStore
      .getState()
      .setHovered(painting?.artworkId ?? null, painting ? paintingIndex : null);
  };

  const trackRoom = () => {
    const idx = roomIndexAt(world, camera.position.x, camera.position.z);
    // -1 inside a doorway: keep the previous room until the visitor is
    // clearly in the next one.
    if (idx === -1 || idx === roomIndex.current) return;
    roomIndex.current = idx;
    useMuseumStore.getState().setRoomIndex(idx);
  };

  /** Throttled publish of the camera pose for the minimap. */
  const publishPose = (delta: number, force = false) => {
    publishAcc.current += delta;
    if (!force && publishAcc.current <= PUBLISH_INTERVAL) return;
    publishAcc.current = 0;
    const yaw = scratch.euler.setFromQuaternion(camera.quaternion, "YXZ").y;
    const store = useMuseumStore.getState();
    const p = store.player;
    if (
      force ||
      Math.abs(p.x - camera.position.x) > 0.05 ||
      Math.abs(p.z - camera.position.z) > 0.05 ||
      Math.abs(p.angle - yaw) > 0.03
    ) {
      store.setPlayer(camera.position.x, camera.position.z, yaw);
    }
  };

  // Cap the demand loop to ~60fps. invalidate() always renders on the next
  // rAF, so on a 120/144Hz display a walking scene renders at the full refresh
  // rate — the cause of the high active CPU+GPU. Delaying the next request to a
  // 60fps cadence roughly halves the work on high-refresh monitors with no
  // visible difference, and is a no-op at 60Hz.
  const requestFrame = () => {
    if (frameTimer.current !== null) return;
    const wait = Math.max(0, FRAME_MS - (performance.now() - lastFrameAt.current));
    frameTimer.current = setTimeout(() => {
      frameTimer.current = null;
      lastFrameAt.current = performance.now();
      invalidate();
    }, wait);
  };

  /** A camera pose framing a painting head-on, written into `out`. `side`
   * shifts the view sideways (>0 leaves room for the inspect panel; 0 centers
   * it for the tour); `fitH`/`fitV` are the fractions of the viewport the
   * canvas fills. The viewpoint stays inside the painting's room. */
  const computeViewPose = (painting: PaintingLayout, fit: ViewFit, out: Pose) => {
    const p = scratch.p.set(...painting.position);
    const n = scratch.n.set(...painting.normal);
    const persp = camera as THREE.PerspectiveCamera;
    const tanV = Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2);
    const tanH = tanV * persp.aspect;
    const distV = painting.height / 2 / (tanV * fit.fitV);
    const distH = painting.width / 2 / (tanH * fit.fitH);
    let dist = Math.max(distV, distH, 1.15) + 0.12;

    const room = world.rooms[painting.roomIndex];
    if (room) {
      if (Math.abs(n.x) > 1e-6) {
        const toWall = n.x > 0 ? room.maxX - WALK_INSET - p.x : p.x - (room.minX + WALK_INSET);
        dist = Math.min(dist, toWall / Math.abs(n.x));
      }
      if (Math.abs(n.z) > 1e-6) {
        const toWall = n.z > 0 ? room.maxZ - WALK_INSET - p.z : p.z - (room.minZ + WALK_INSET);
        dist = Math.min(dist, toWall / Math.abs(n.z));
      }
      dist = Math.max(dist, PLAYER_RADIUS);
    }

    const right = scratch.right.copy(n).negate().cross(UP).normalize();
    const sideShift = fit.side > 0 ? Math.min(2 * dist * tanH * fit.side, painting.width) : 0;

    out.position.copy(p).addScaledVector(n, dist).addScaledVector(right, sideShift);
    if (room) {
      const inside = clampIntoRoom(room, out.position.x, out.position.z);
      out.position.x = inside.x;
      out.position.z = inside.z;
    }
    const lookAt = scratch.lookAt.copy(p).addScaledVector(right, sideShift);
    out.quaternion.setFromRotationMatrix(scratch.mat.lookAt(out.position, lookAt, UP));
    return out;
  };

  const setInspectPhase = (phase: InspectPhase) => {
    const ins = inspect.current;
    ins.phase = phase;
    const idle = phase === "idle";
    useMuseumStore
      .getState()
      .setInspect(
        idle ? null : (ins.painting?.artworkId ?? null),
        idle || ins.index < 0 ? null : ins.index,
        phase,
      );
  };

  const finishReturn = () => {
    inspect.current.painting = null;
    inspect.current.index = -1;
    setInspectPhase("idle");
    syncLookFromCamera();
    invalidate();
  };

  const requestLock = () => {
    const el = gl.domElement;
    if (document.pointerLockElement === el) return;
    // A denied request also fires pointerlockerror, handled below; swallowing
    // the rejection only keeps the console clean.
    void Promise.resolve(el.requestPointerLock()).catch(() => {});
  };

  const mirrorTour = () => {
    const t = tour.current;
    const order = world.tourOrder;
    const paintingIndex = order[Math.min(t.index, order.length - 1)];
    useMuseumStore.getState().setTour({
      active: t.active,
      paused: t.paused,
      index: t.index,
      total: order.length,
      artworkId:
        t.active && paintingIndex !== undefined
          ? (world.paintings[paintingIndex]?.artworkId ?? null)
          : null,
    });
  };

  const setTourIndex = (index: number) => {
    tour.current.index = index;
    tour.current.glide = null;
    mirrorTour();
    invalidate();
  };

  const endTour = () => {
    const t = tour.current;
    if (!t.active) return;
    t.active = false;
    t.paused = false;
    t.glide = null;
    camera.position.y = EYE_HEIGHT;
    syncLookFromCamera();
    trackRoom();
    mirrorTour();
    invalidate();
  };

  /** Build the glide to tour painting `index`: a polyline from where the
   * camera is now, through any doorways between rooms, to the centered view
   * pose — plus the eased duration for that path length. */
  const buildGlide = (index: number, painting: PaintingLayout): TourGlide => {
    const finalPose = computeViewPose(painting, TOUR_FIT, newPose());
    const path: THREE.Vector3[] = [camera.position.clone()];
    for (const wp of doorwayWaypoints(world, roomIndex.current, painting.roomIndex)) {
      path.push(new THREE.Vector3(wp.x, wp.y, wp.z));
    }
    path.push(finalPose.position);

    const segLens: number[] = [];
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const d = a && b ? a.distanceTo(b) : 0;
      segLens.push(d);
      total += d;
    }
    return {
      index,
      phase: "glide",
      t: 0,
      duration: THREE.MathUtils.clamp(total / TOUR_CRUISE, TOUR_MIN_GLIDE, TOUR_MAX_GLIDE),
      dwell: 0,
      path,
      segLens,
      total,
      finalQuat: finalPose.quaternion,
    };
  };

  const stepTour = (delta: number) => {
    const t = tour.current;
    const order = world.tourOrder;
    if (order.length === 0) {
      endTour();
      return;
    }
    const idx = Math.min(t.index, order.length - 1);
    const paintingIndex = order[idx];
    const painting = paintingIndex !== undefined ? world.paintings[paintingIndex] : undefined;
    if (!painting) {
      endTour();
      return;
    }
    if (!t.glide || t.glide.index !== idx) {
      t.glide = buildGlide(idx, painting);
      mirrorTour();
    }
    const g = t.glide;

    if (!t.paused && g.phase === "glide") {
      g.t = Math.min(g.t + delta, g.duration);
      const u = easeInOut(g.duration > 0 ? g.t / g.duration : 1);
      const s = u * g.total;
      samplePath(g.path, g.segLens, g.total, s, scratch.pos);
      camera.position.copy(scratch.pos);

      // Face the way we're travelling, then turn to the painting over the
      // last stretch so we arrive looking straight at it.
      const remaining = g.total - s;
      samplePath(g.path, g.segLens, g.total, Math.min(s + TOUR_LOOKAHEAD, g.total), scratch.ahead);
      let targetQuat = g.finalQuat;
      if (remaining > 1e-3 && scratch.ahead.distanceToSquared(scratch.pos) > 1e-6) {
        const travelQuat = scratch.quat.setFromRotationMatrix(
          scratch.mat.lookAt(scratch.pos, scratch.ahead, UP),
        );
        if (remaining <= TOUR_APPROACH) {
          travelQuat.slerp(g.finalQuat, easeInOut(1 - remaining / TOUR_APPROACH));
        }
        targetQuat = travelQuat;
      }
      camera.quaternion.slerp(targetQuat, 1 - Math.exp(-TOUR_TURN_DAMP * delta));

      if (g.t >= g.duration) {
        g.phase = "dwell";
        g.dwell = 0;
      }
    } else if (!t.paused) {
      // Dwell: hold at the painting, finish settling onto it, advance.
      const end = g.path[g.path.length - 1];
      if (end) camera.position.copy(end);
      camera.quaternion.slerp(g.finalQuat, 1 - Math.exp(-TOUR_TURN_DAMP * delta));
      g.dwell += delta;
      if (g.dwell >= TOUR_DWELL) {
        if (idx + 1 < order.length) setTourIndex(idx + 1);
        else {
          endTour();
          return;
        }
      }
    }

    trackRoom();
    publishPose(delta);
    // A running glide (or settling dwell) needs the next frame; a paused
    // tour holds still and lets the loop sleep until a control wakes it.
    if (!t.paused) requestFrame();
  };

  const stepWalk = (delta: number, touch: boolean) => {
    applyLook();

    const k = keys.current;
    const m = move.current;
    const input = scratch.input.set(
      (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0) + m.x,
      (k.KeyS || k.ArrowDown ? 1 : 0) - (k.KeyW || k.ArrowUp ? 1 : 0) + m.y,
    );
    // Clamp (not normalize) so analog joystick input keeps partial speed
    // while keyboard diagonals stay capped at full speed.
    if (input.lengthSq() > 1) input.normalize();
    input.multiplyScalar(k.ShiftLeft || k.ShiftRight ? SPRINT_SPEED : WALK_SPEED);
    const sin = Math.sin(look.current.yaw);
    const cos = Math.cos(look.current.yaw);
    const target = scratch.target.set(input.x * cos + input.y * sin, input.y * cos - input.x * sin);
    const velocity = scratch.velocity;
    velocity.x = THREE.MathUtils.damp(velocity.x, target.x, VELOCITY_DAMP, delta);
    velocity.y = THREE.MathUtils.damp(velocity.y, target.y, VELOCITY_DAMP, delta);

    // Only the nearby walls can block the player; testing every wall in a
    // long museum each frame is wasted work.
    const colliders = world.collidersByRoom[roomIndex.current] ?? world.colliders;
    const next = collideAndSlide(
      { x: camera.position.x, z: camera.position.z },
      {
        x: camera.position.x + velocity.x * delta,
        z: camera.position.z + velocity.y * delta,
      },
      colliders,
    );
    camera.position.set(next.x, EYE_HEIGHT, next.z);
    trackRoom();

    // Crosshair pick → hover state (desktop only; touch uses tap). A hover
    // highlight doesn't need 60Hz precision, so run it a few times a second.
    if (touch) return;
    hoverAcc.current += delta;
    if (hoverAcc.current < HOVER_INTERVAL) return;
    hoverAcc.current = 0;
    const forward = scratch.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    setHover(
      pickPaintingRay(
        world,
        hoverCandidates[roomIndex.current] ?? allPaintings,
        camera.position,
        forward,
        PICK_RANGE,
        PICK_PAD,
        world.walls,
      ),
    );
  };

  const requestInspect = (paintingIndex: number) => {
    const ins = inspect.current;
    if (ins.phase !== "idle") return;
    const painting = world.paintings[paintingIndex];
    if (!painting) return;
    useMuseumStore.getState().markEntered();
    if (document.pointerLockElement) document.exitPointerLock();
    setHover(-1);
    ins.painting = painting;
    ins.index = paintingIndex;
    ins.t = 0;
    ins.from.position.copy(camera.position);
    ins.from.quaternion.copy(camera.quaternion);
    computeViewPose(painting, INSPECT_FIT, ins.to);
    setInspectPhase("approaching");
    invalidate();
  };

  /** The store's public API carries only an artwork id, so a work hung in more
   * than one room resolves to its first placement. The in-scene picks below
   * know which canvas was actually aimed at and pass the index straight in. */
  const requestInspectById = (artworkId: string) => {
    const index = world.paintings.findIndex((p) => p.artworkId === artworkId);
    if (index >= 0) requestInspect(index);
  };

  const requestCloseInspect = (resumeWalk: boolean) => {
    const ins = inspect.current;
    if (ins.phase !== "open" && ins.phase !== "approaching") return;
    setInspectPhase("returning");
    // Re-grab the pointer inside the closing click: the returning glide
    // plays under the lock (mouse motion is ignored until idle) so desktop
    // lands back in walking instead of the paused overlay.
    if (resumeWalk && !tour.current.active && !useMuseumStore.getState().isTouch) {
      requestLock();
    }
    invalidate();
  };

  const startTour = () => {
    if (world.tourOrder.length === 0 || tour.current.active) return;
    const store = useMuseumStore.getState();
    store.markEntered();
    // The pointer has to release so the on-screen tour controls become
    // clickable (and the mouse stops steering the camera mid-glide).
    if (document.pointerLockElement) document.exitPointerLock();
    if (!autopilot) setWalking(false);
    setHover(-1);
    tour.current.active = true;
    tour.current.paused = false;
    setTourIndex(0);
  };

  const teleport = (x: number, z: number) => {
    if (tour.current.active || inspect.current.phase !== "idle") return;
    const idx = nearestRoomIndex(world, x, z);
    const room = world.rooms[idx];
    if (!room) return;
    const inside = clampIntoRoom(room, x, z);
    camera.position.set(inside.x, EYE_HEIGHT, inside.z);
    scratch.velocity.set(0, 0);
    roomIndex.current = idx;
    useMuseumStore.getState().setRoomIndex(idx);
    publishPose(0, true);
    invalidate();
  };

  // Spawn pose + world mirror. Also the reset point when the world changes
  // under a mounted rig (the dev harness re-generates content in place).
  useEffect(() => {
    const store = useMuseumStore.getState();
    camera.position.set(world.spawn[0], EYE_HEIGHT, world.spawn[2]);
    look.current = { yaw: world.spawnYaw, pitch: 0 };
    applyLook();
    scratch.velocity.set(0, 0);
    roomIndex.current = Math.max(roomIndexAt(world, world.spawn[0], world.spawn[2]), 0);
    hoveredIndex.current = -1;
    inspect.current.phase = "idle";
    inspect.current.painting = null;
    inspect.current.index = -1;
    tour.current = { active: false, paused: false, index: 0, glide: null };
    store.setWorld(world);
    store.setRoomIndex(roomIndex.current);
    store.setHovered(null, null);
    store.setInspect(null, null, "idle");
    store.setTour({
      active: false,
      paused: false,
      index: 0,
      total: world.tourOrder.length,
      artworkId: null,
    });
    publishPose(0, true);
    invalidate();
  }, [world, camera, invalidate]);

  useEffect(() => {
    if (!autopilot) return;
    camera.position.set(autopilot.x ?? world.spawn[0], EYE_HEIGHT, autopilot.z ?? world.spawn[2]);
    look.current = {
      yaw: autopilot.yaw ?? world.spawnYaw,
      pitch: autopilot.pitch ?? 0,
    };
    applyLook();
    trackRoom();
    useMuseumStore.getState().markEntered();
    setWalking(true);
    publishPose(0, true);
    invalidate();
  }, [autopilot, world, camera, invalidate]);

  useEffect(() => {
    const controller: MuseumController = {
      engage: (touch) => {
        if (autopilot) return;
        useMuseumStore.getState().markEntered();
        if (touch) setWalking(true);
        else requestLock();
      },
      release: () => {
        if (autopilot) return;
        if (document.pointerLockElement) document.exitPointerLock();
        setWalking(false);
      },
      startTour,
      endTour,
      tourNext: () => {
        const t = tour.current;
        if (!t.active) return;
        if (t.index + 1 < world.tourOrder.length) setTourIndex(t.index + 1);
        else endTour();
      },
      tourPrev: () => {
        const t = tour.current;
        if (t.active && t.index > 0) setTourIndex(t.index - 1);
      },
      tourTogglePause: () => {
        const t = tour.current;
        if (!t.active) return;
        t.paused = !t.paused;
        mirrorTour();
        invalidate();
      },
      requestInspect: requestInspectById,
      requestCloseInspect,
      teleport,
      setMoveInput: (x, y) => {
        move.current.x = x;
        move.current.y = y;
        invalidate();
      },
    };
    useMuseumStore.getState().setController(controller);
    return () => useMuseumStore.getState().setController(null);
  }, [autopilot, world, camera, gl, invalidate]);

  // The Canvas runs frameloop="demand", so the GPU idles unless a frame is
  // requested. Any store change (lock, tour, inspect, teleport, joystick,
  // hover, room) wakes the loop; continuous motion re-arms itself from inside
  // useFrame.
  useEffect(() => useMuseumStore.subscribe(() => invalidate()), [invalidate]);

  useEffect(
    () => () => {
      if (frameTimer.current !== null) clearTimeout(frameTimer.current);
    },
    [],
  );

  // Desktop: pointer lock, mouse-look, keyboard and click-to-inspect.
  useEffect(() => {
    const el = gl.domElement;

    const onLockChange = () => {
      if (autopilot) return;
      const locked = document.pointerLockElement === el;
      if (locked) useMuseumStore.getState().markEntered();
      else keys.current = {};
      setWalking(locked);
    };
    // A denied lock request (e.g. clicking "Resume walking" inside Chrome's
    // ~1.25s pointer-lock re-entry cooldown) fires no pointerlockchange, so
    // roll the walk state back here so the pause overlay returns.
    const onLockError = () => {
      if (!autopilot) setWalking(false);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== el) return;
      if (inspect.current.phase !== "idle" || tour.current.active) return;
      look.current.yaw -= e.movementX * LOOK_SENS;
      look.current.pitch = THREE.MathUtils.clamp(
        look.current.pitch - e.movementY * LOOK_SENS,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
    };
    const onMouseDown = () => {
      if (!walking.current || hoveredIndex.current === -1) return;
      if (inspect.current.phase !== "idle" || tour.current.active) return;
      requestInspect(hoveredIndex.current);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
      if (e.code !== "KeyT" || e.repeat) return;
      if (
        walking.current &&
        !useMuseumStore.getState().isTouch &&
        !tour.current.active &&
        inspect.current.phase === "idle"
      ) {
        startTour();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };

    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("pointerlockerror", onLockError);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("pointerlockerror", onLockError);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [gl, world, autopilot]);

  // Touch look + tap-to-inspect on the canvas. The on-screen joystick is a
  // separate DOM element, so its touches never reach here — leaving the rest
  // of the screen for looking and tapping.
  useEffect(() => {
    if (!isTouch) return;
    const el = gl.domElement;

    const inspectAt = (clientX: number, clientY: number) => {
      if (!walking.current || inspect.current.phase !== "idle") return;
      if (tour.current.active) return;
      const rect = el.getBoundingClientRect();
      const dir = scratch.forward
        .set(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
          0.5,
        )
        .unproject(camera)
        .sub(camera.position)
        .normalize();
      const hit = pickPaintingRay(
        world,
        allPaintings,
        camera.position,
        dir,
        TAP_RANGE,
        0,
        world.walls,
      );
      if (hit >= 0) requestInspect(hit);
    };

    const onStart = (e: TouchEvent) => {
      if (lookTouch.current) return;
      const t = e.changedTouches[0];
      if (!t) return;
      // Continue looking from wherever the camera currently points.
      syncLookFromCamera();
      lookTouch.current = {
        id: t.identifier,
        lastX: t.clientX,
        lastY: t.clientY,
        startX: t.clientX,
        startY: t.clientY,
        startMs: performance.now(),
        moved: false,
      };
    };

    const onMove = (e: TouchEvent) => {
      const lt = lookTouch.current;
      if (!lt) return;
      const t = Array.from(e.changedTouches).find((touch) => touch.identifier === lt.id);
      if (!t) return;
      e.preventDefault();
      const dx = t.clientX - lt.lastX;
      const dy = t.clientY - lt.lastY;
      lt.lastX = t.clientX;
      lt.lastY = t.clientY;
      if (Math.hypot(t.clientX - lt.startX, t.clientY - lt.startY) > TAP_MOVE_PX) {
        lt.moved = true;
      }
      if (!walking.current || inspect.current.phase !== "idle") return;
      look.current.yaw -= dx * TOUCH_LOOK_SENS;
      look.current.pitch = THREE.MathUtils.clamp(
        look.current.pitch - dy * TOUCH_LOOK_SENS,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
      invalidate();
    };

    const onEnd = (e: TouchEvent) => {
      const lt = lookTouch.current;
      if (!lt) return;
      const ended = Array.from(e.changedTouches).some((touch) => touch.identifier === lt.id);
      if (!ended) return;
      const quick = performance.now() - lt.startMs < TAP_MS;
      if (!lt.moved && quick) inspectAt(lt.startX, lt.startY);
      lookTouch.current = null;
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [isTouch, gl, camera, world, allPaintings, invalidate]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, MAX_DELTA);
    const ins = inspect.current;

    if (ins.phase === "approaching" || ins.phase === "returning") {
      const dir = ins.phase === "approaching" ? 1 : -1;
      ins.t = THREE.MathUtils.clamp(ins.t + (dir * delta) / INSPECT_SECONDS, 0, 1);
      const k = easeInOut(ins.t);
      camera.position.lerpVectors(ins.from.position, ins.to.position, k);
      camera.quaternion.slerpQuaternions(ins.from.quaternion, ins.to.quaternion, k);
      if (ins.phase === "approaching" && ins.t >= 1) setInspectPhase("open");
      else if (ins.phase === "returning" && ins.t <= 0) finishReturn();
      else requestFrame();
      publishPose(delta);
      return;
    }
    // The tour is frozen while a painting is open; it resumes on return.
    if (ins.phase === "open") return;

    if (tour.current.active) {
      stepTour(delta);
      return;
    }

    if (walking.current) {
      stepWalk(delta, useMuseumStore.getState().isTouch);
    } else if (hoveredIndex.current !== -1) {
      setHover(-1);
    }

    publishPose(delta);
    // While walking the player is actively moving/looking, so keep requesting
    // frames (capped to ~60fps). Otherwise nothing here moves the camera, so
    // request none and let the GPU idle.
    if (walking.current) requestFrame();
  });

  return null;
}
