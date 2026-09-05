import { PointerLockControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import {
  collideAndSlide,
  EYE_HEIGHT,
  type PaintingLayout,
  PLAYER_RADIUS,
  WALL_THICKNESS,
  type WorldLayout,
} from "./layout";
import { useMuseumStore } from "./store";

const WALK_SPEED = 3.4;
const SPRINT_SPEED = 5.4;
const INSPECT_SECONDS = 0.95;

/** Fraction of the viewport the painting may fill while inspecting —
 * leaves room for the info panel on the right. */
const FIT_H = 0.52;
const FIT_V = 0.78;

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

type Pose = { position: THREE.Vector3; quaternion: THREE.Quaternion };

export function PlayerRig({
  world,
  registry,
}: {
  world: WorldLayout;
  registry: Map<THREE.Object3D, PaintingLayout>;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controlsRef = useRef<React.ComponentRef<typeof PointerLockControls> | null>(null);

  const keys = useRef<Record<string, boolean>>({});
  const velocity = useRef(new THREE.Vector2(0, 0));
  const raycaster = useMemo(() => {
    const r = new THREE.Raycaster();
    r.far = 7;
    return r;
  }, []);

  const anim = useRef<{
    t: number;
    from: Pose | null;
    to: Pose | null;
    saved: Pose | null;
  }>({ t: 0, from: null, to: null, saved: null });

  // Spawn position.
  useEffect(() => {
    camera.position.set(...world.spawn);
    camera.lookAt(world.spawn[0], EYE_HEIGHT, world.spawn[2] + 4);
  }, [camera, world]);

  // Keyboard + lock-request + click-to-inspect listeners.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    const requestLock = () => controlsRef.current?.lock();
    const mousedown = () => {
      const { locked, hovered, inspectPhase, openInspect } = useMuseumStore.getState();
      if (locked && hovered && inspectPhase === "idle") {
        document.exitPointerLock();
        openInspect(hovered);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("museum:lock", requestLock);
    document.addEventListener("mousedown", mousedown);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("museum:lock", requestLock);
      document.removeEventListener("mousedown", mousedown);
    };
  }, []);

  const computeInspectPose = (layout: PaintingLayout): Pose => {
    const p = new THREE.Vector3(...layout.position);
    const n = new THREE.Vector3(...layout.normal);
    const persp = camera as THREE.PerspectiveCamera;
    const vFov = THREE.MathUtils.degToRad(persp.fov);
    const tanV = Math.tan(vFov / 2);
    const tanH = tanV * persp.aspect;
    const distV = layout.height / 2 / (tanV * FIT_V);
    const distH = layout.width / 2 / (tanH * FIT_H);
    let dist = Math.max(distV, distH, 1.15) + 0.12;

    // Keep the viewpoint inside the room.
    const room = world.rooms[layout.roomIndex];
    if (room) {
      const maxByX =
        (world.buildingWidth / 2 - WALL_THICKNESS - PLAYER_RADIUS) / Math.max(Math.abs(n.x), 1e-6);
      const maxByZ = Math.min(
        n.z > 0 ? room.maxZ - WALL_THICKNESS - PLAYER_RADIUS - p.z : Number.POSITIVE_INFINITY,
        n.z < 0 ? p.z - (room.minZ + WALL_THICKNESS + PLAYER_RADIUS) : Number.POSITIVE_INFINITY,
      );
      dist = Math.min(dist, Math.abs(n.x) > 0.5 ? maxByX : maxByZ);
    }

    // Shift the view sideways so the painting sits left of the info panel.
    const forward = n.clone().negate();
    const right = forward
      .clone()
      .cross(new THREE.Vector3(0, 1, 0))
      .normalize();
    const sideShift = Math.min(2 * dist * tanH * 0.16, layout.width);

    const position = p.clone().addScaledVector(n, dist).addScaledVector(right, sideShift);
    const lookAt = p.clone().addScaledVector(right, sideShift);
    const m = new THREE.Matrix4().lookAt(position, lookAt, new THREE.Vector3(0, 1, 0));
    return {
      position,
      quaternion: new THREE.Quaternion().setFromRotationMatrix(m),
    };
  };

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    const store = useMuseumStore.getState();

    // ---- Inspect camera animation ----
    if (store.inspectPhase === "approaching" && store.inspected) {
      if (!anim.current.to) {
        anim.current.saved = {
          position: camera.position.clone(),
          quaternion: camera.quaternion.clone(),
        };
        anim.current.from = anim.current.saved;
        anim.current.to = computeInspectPose(store.inspected);
        anim.current.t = 0;
      }
      anim.current.t = Math.min(anim.current.t + delta / INSPECT_SECONDS, 1);
      const k = easeInOut(anim.current.t);
      camera.position.lerpVectors(anim.current.from!.position, anim.current.to!.position, k);
      camera.quaternion.slerpQuaternions(
        anim.current.from!.quaternion,
        anim.current.to!.quaternion,
        k,
      );
      if (anim.current.t >= 1) {
        store.inspectArrived();
      }
      return;
    }
    if (store.inspectPhase === "open") {
      return;
    }
    if (store.inspectPhase === "returning") {
      if (anim.current.saved && anim.current.to) {
        anim.current.t = Math.max(anim.current.t - delta / INSPECT_SECONDS, 0);
        const k = easeInOut(anim.current.t);
        camera.position.lerpVectors(anim.current.saved.position, anim.current.to.position, k);
        camera.quaternion.slerpQuaternions(
          anim.current.saved.quaternion,
          anim.current.to.quaternion,
          k,
        );
        if (anim.current.t <= 0) {
          anim.current.to = null;
          anim.current.from = null;
          store.inspectReturned();
        }
      } else {
        store.inspectReturned();
      }
      return;
    }

    // ---- Walking ----
    if (store.locked) {
      const k = keys.current;
      const input = new THREE.Vector2(
        (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0),
        (k.KeyS || k.ArrowDown ? 1 : 0) - (k.KeyW || k.ArrowUp ? 1 : 0),
      );
      const speed = k.ShiftLeft || k.ShiftRight ? SPRINT_SPEED : WALK_SPEED;
      if (input.lengthSq() > 0) {
        input.normalize().multiplyScalar(speed);
      }
      // Rotate input by camera yaw.
      const yaw = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ").y;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const target = new THREE.Vector2(
        input.x * cos + input.y * sin,
        input.y * cos - input.x * sin,
      );
      velocity.current.x = THREE.MathUtils.damp(velocity.current.x, target.x, 10, delta);
      velocity.current.y = THREE.MathUtils.damp(velocity.current.y, target.y, 10, delta);

      const next = collideAndSlide(
        { x: camera.position.x, z: camera.position.z },
        {
          x: camera.position.x + velocity.current.x * delta,
          z: camera.position.z + velocity.current.y * delta,
        },
        world.colliders,
      );
      camera.position.set(next.x, EYE_HEIGHT, next.z);

      // Track current room for the HUD.
      const z = camera.position.z;
      const idx = world.rooms.findIndex((r) => z >= r.minZ && z <= r.maxZ);
      if (idx !== -1 && idx !== store.roomIndex) {
        store.setRoomIndex(idx);
      }

      // Crosshair raycast → hover state.
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const meshes = [...registry.keys()];
      const hits = raycaster.intersectObjects(meshes, false);
      const hit = hits[0] ? (registry.get(hits[0].object) ?? null) : null;
      if (hit !== store.hovered) {
        store.setHovered(hit);
      }
    } else if (store.hovered) {
      store.setHovered(null);
    }
  });

  const setLocked = useMuseumStore((s) => s.setLocked);

  return (
    <PointerLockControls
      ref={controlsRef}
      domElement={gl.domElement}
      onLock={() => setLocked(true)}
      onUnlock={() => setLocked(false)}
    />
  );
}
