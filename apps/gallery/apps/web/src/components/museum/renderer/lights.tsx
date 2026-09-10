import type { PaintingLayout, WorldLayout } from "@aqt/gallery-layout";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { useMuseumStore } from "../store";
import { CANVAS_LIFT, FRAME_BORDER, TRACK_LIGHT_DROP, TRACK_LIGHT_REACH } from "./constants";
import { roomWindow } from "./room-window";

/** Light only the player's room and the rooms one doorway away; a painting two
 * rooms off contributes nothing the player can see through a doorway. */
const LIT_ROOM_RADIUS = 1;

/** Hard ceiling on simultaneously-lit paintings. Every spotlight is forward-
 * shaded per fragment, so this count is the dominant per-pixel GPU cost. */
const MAX_PAINTING_LIGHTS = 6;
const PAINTING_LIGHT_INTENSITY = 42;
/** Re-picking the lit set a few times a second is plenty. */
const REPICK_SECONDS = 0.1;

type LightSpec = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  angle: number;
};

/** World-space spotlight placement for a painting, mirroring its cosmetic
 * housing: dropped from the ceiling, pulled into the room along the wall
 * normal, aimed at the canvas centre. */
function paintingLightSpec(p: PaintingLayout, ceilingHeight: number): LightSpec {
  const [px, py, pz] = p.position;
  const sin = Math.sin(p.rotationY);
  const cos = Math.cos(p.rotationY);
  const lightY = ceilingHeight - TRACK_LIGHT_DROP;
  const position = new THREE.Vector3(
    px + TRACK_LIGHT_REACH * sin,
    lightY,
    pz + TRACK_LIGHT_REACH * cos,
  );
  const target = new THREE.Vector3(px + CANVAS_LIFT * sin, py, pz + CANVAS_LIFT * cos);
  const frameW = p.width + FRAME_BORDER * 2;
  const frameH = p.height + FRAME_BORDER * 2;
  const dist = Math.hypot(lightY - py, TRACK_LIGHT_REACH - CANVAS_LIFT);
  const halfDiag = Math.hypot(frameW, frameH) / 2;
  const angle = THREE.MathUtils.clamp(Math.atan2(halfDiag * 1.25, dist), 0.22, 0.85);
  return { position, target, angle };
}

/** Pool size = the most paintings ever lit at once (busiest room window),
 * capped. Fixed for the life of a gallery so the visible-light count never
 * changes while walking. */
function sizeAccentPool(world: WorldLayout, windows: number[][]): number {
  let max = 0;
  for (const rooms of windows) {
    let sum = 0;
    for (const r of rooms) sum += world.paintingsByRoom[r]?.length ?? 0;
    max = Math.max(max, sum);
  }
  return Math.min(MAX_PAINTING_LIGHTS, Math.max(1, max));
}

/** A fixed pool of track spotlights driven to the paintings nearest the
 * camera. three.js bakes the visible-light count into every shader program,
 * so toggling per-painting lights would recompile on the first entry into
 * each room; parking spares at zero intensity keeps the count constant. */
export function AccentLights({ world, color }: { world: WorldLayout; color: string }) {
  const specs = useMemo(
    () => world.paintings.map((p) => paintingLightSpec(p, world.rooms[p.roomIndex]?.height ?? 5)),
    [world],
  );
  const windows = useMemo(
    () => world.rooms.map((_, i) => roomWindow(world, i, LIT_ROOM_RADIUS)),
    [world],
  );
  const poolSize = useMemo(() => sizeAccentPool(world, windows), [world, windows]);
  const scratch = useMemo(() => {
    const camera = new THREE.Vector3();
    return {
      lit: [] as number[],
      camera,
      acc: 0,
      primed: false,
      byDistance: (a: number, b: number) =>
        (specs[a]?.target.distanceToSquared(camera) ?? 0) -
        (specs[b]?.target.distanceToSquared(camera) ?? 0),
    };
  }, [specs]);

  const lights = useRef<(THREE.SpotLight | null)[]>([]);
  const targets = useRef<(THREE.Object3D | null)[]>([]);

  useEffect(() => {
    for (let i = 0; i < poolSize; i++) {
      const light = lights.current[i];
      const target = targets.current[i];
      if (light && target) light.target = target;
    }
  }, [poolSize]);

  useFrame(({ camera }, delta) => {
    scratch.acc += delta;
    if (scratch.primed && scratch.acc < REPICK_SECONDS) return;
    scratch.acc = 0;
    scratch.primed = true;

    const current = useMuseumStore.getState().roomIndex;
    const lit = scratch.lit;
    lit.length = 0;
    for (const room of windows[current] ?? []) {
      for (const i of world.paintingsByRoom[room] ?? []) lit.push(i);
    }
    if (lit.length > poolSize) {
      scratch.camera.copy(camera.position);
      lit.sort(scratch.byDistance);
      lit.length = poolSize;
    }

    for (let i = 0; i < poolSize; i++) {
      const light = lights.current[i];
      if (!light) continue;
      const index = lit[i];
      const spec = index === undefined ? undefined : specs[index];
      if (!spec) {
        light.intensity = 0;
        continue;
      }
      light.position.copy(spec.position);
      light.angle = spec.angle;
      light.intensity = PAINTING_LIGHT_INTENSITY;
      const target = targets.current[i];
      if (target) {
        target.position.copy(spec.target);
        target.updateMatrixWorld();
      }
    }
  });

  return (
    <>
      {Array.from({ length: poolSize }, (_, i) => (
        // Fixed-size pool
        <group key={i}>
          <spotLight
            ref={(el) => {
              lights.current[i] = el;
            }}
            color={color}
            intensity={0}
            distance={0}
            angle={0.5}
            penumbra={0.65}
            decay={2}
          />
          <object3D
            ref={(el) => {
              targets.current[i] = el;
            }}
          />
        </group>
      ))}
    </>
  );
}

/** The single shadow-casting light, parked at the current room's ceiling
 * centre. Shadow maps are baked on demand (the rig turns autoUpdate off), so
 * it moves and re-bakes only when the player crosses into another room. */
export function RoomShadowLight({ world, color }: { world: WorldLayout; color: string }) {
  const gl = useThree((s) => s.gl);
  const light = useRef<THREE.SpotLight>(null);
  const target = useRef<THREE.Object3D>(null);
  const placed = useRef<{ room: number; world: WorldLayout | null }>({
    room: -1,
    world: null,
  });

  useEffect(() => {
    if (light.current && target.current) light.current.target = target.current;
  }, []);

  useFrame(() => {
    const current = useMuseumStore.getState().roomIndex;
    if (placed.current.room === current && placed.current.world === world) {
      return;
    }
    const room = world.rooms[current];
    const spot = light.current;
    const aim = target.current;
    if (!room || !spot || !aim) return;
    placed.current = { room: current, world };
    spot.position.set(room.centerX, room.height - 0.15, room.centerZ);
    aim.position.set(room.centerX, 0, room.centerZ);
    aim.updateMatrixWorld();
    gl.shadowMap.needsUpdate = true;
  });

  return (
    <group>
      <spotLight
        ref={light}
        color={color}
        intensity={26}
        angle={1.05}
        penumbra={0.9}
        decay={1.6}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0004}
      />
      <object3D ref={target} />
    </group>
  );
}

/** Compile every shader program up front so stepping into a room never stalls
 * on synchronous compilation. Safe to run once: the light pools keep the
 * visible-light count constant, so the programs warmed here are exactly the
 * ones used throughout the walk. */
export function ScenePrewarm() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    void gl.compileAsync(scene, camera);
  }, [gl, scene, camera]);
  return null;
}
