import type { PaintingLayout, WorldLayout } from "@aqt/gallery-layout";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { useMuseumStore } from "../store";
import type { ArtworkData } from "../types";
import {
  CANVAS_Z,
  FRAME_ANTIQUE_COLOR,
  FRAME_BORDER,
  FRAME_DARK_COLOR,
  FRAME_DEPTH,
  FRAME_GLOW_COLOR,
  HOUSING_COLOR,
  LIP_COLOR,
  LIP_Z,
  PLAQUE_COLOR,
  PLAQUE_HEIGHT,
  PLAQUE_WIDTH,
  TRACK_LIGHT_DROP,
  TRACK_LIGHT_REACH,
} from "./constants";
import { Instances, placement, UNIT_BOX, UNIT_PLANE } from "./instanced";
import {
  bakeMissingLabel,
  buildPlaqueAtlas,
  buildPlaqueTextGeometries,
  type PlaqueLabel,
} from "./text-atlas";
import { loadingCanvasTexture, TextureStreamer } from "./texture-streamer";

const TRACK_LIGHT_GEOMETRY = new THREE.CylinderGeometry(0.055, 0.075, 0.22, 16);
const STREAM_TICK_MS = 250;
const GLOW_TARGET = 0.32;
const GLOW_DAMP = 12;
/** The glow box wraps the frame by this much so it wins the depth test. */
const GLOW_PAD = 0.006;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Shared radial-gradient texture faking the soft drop shadow a hung frame
 * throws on the wall; far cheaper than per-painting shadow-casting lights. */
let dropShadowTexture: THREE.Texture | null = null;
function getDropShadowTexture(): THREE.Texture | null {
  if (dropShadowTexture || typeof document === "undefined") {
    return dropShadowTexture;
  }
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.18,
    size / 2,
    size / 2,
    size * 0.5,
  );
  g.addColorStop(0, "rgba(0,0,0,0.42)");
  g.addColorStop(0.7, "rgba(0,0,0,0.16)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  dropShadowTexture = new THREE.CanvasTexture(canvas);
  return dropShadowTexture;
}

function isAntique(artwork: ArtworkData | undefined): boolean {
  const year = Number.parseInt(artwork?.year ?? "", 10);
  return Number.isFinite(year) && year < 1800;
}

type PaintingParts = {
  /** Frame transform per painting index (the hover glow follows these). */
  frames: THREE.Matrix4[];
  antiqueFrames: THREE.Matrix4[];
  darkFrames: THREE.Matrix4[];
  lips: THREE.Matrix4[];
  shadows: THREE.Matrix4[];
  plaques: THREE.Matrix4[];
  plaqueTexts: THREE.Matrix4[];
  housings: THREE.Matrix4[];
  canvasPositions: THREE.Vector3[];
  labels: PlaqueLabel[];
};

function buildPaintingParts(
  world: WorldLayout,
  artworkById: Map<string, ArtworkData>,
): PaintingParts {
  const parts: PaintingParts = {
    frames: [],
    antiqueFrames: [],
    darkFrames: [],
    lips: [],
    shadows: [],
    plaques: [],
    plaqueTexts: [],
    housings: [],
    canvasPositions: [],
    labels: [],
  };
  const base = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const unit = new THREE.Vector3(1, 1, 1);
  const local = (x: number, y: number, z: number, sx: number, sy: number, sz: number, rotX = 0) =>
    placement(x, y, z, sx, sy, sz, rotX).premultiply(base);

  for (const p of world.paintings) {
    const artwork = artworkById.get(p.artworkId);
    const { width: w, height: h } = p;
    const frameW = w + FRAME_BORDER * 2;
    const frameH = h + FRAME_BORDER * 2;
    base.compose(
      position.set(...p.position),
      quaternion.setFromAxisAngle(Y_AXIS, p.rotationY),
      unit,
    );

    const frame = local(0, 0, FRAME_DEPTH / 2, frameW, frameH, FRAME_DEPTH);
    parts.frames.push(frame);
    (isAntique(artwork) ? parts.antiqueFrames : parts.darkFrames).push(frame);
    parts.lips.push(local(0, 0, LIP_Z, w + 0.02, h + 0.02, 1));
    parts.shadows.push(local(0.04, -0.06, 0.006, frameW * 1.5, frameH * 1.5, 1));

    const plaqueX = frameW / 2 + 0.32;
    const plaqueY = -Math.max(0.18, h / 2 - 0.5);
    parts.plaques.push(local(plaqueX, plaqueY, 0.01, PLAQUE_WIDTH, PLAQUE_HEIGHT, 1));
    parts.plaqueTexts.push(local(plaqueX, plaqueY, 0.014, 1, 1, 1));

    const ceiling = world.rooms[p.roomIndex]?.height ?? 5;
    parts.housings.push(
      local(
        0,
        ceiling - TRACK_LIGHT_DROP - p.position[1] + 0.05,
        TRACK_LIGHT_REACH,
        1,
        1,
        1,
        Math.PI / 4,
      ),
    );
    parts.canvasPositions.push(new THREE.Vector3(0, 0, CANVAS_Z).applyMatrix4(base));
    parts.labels.push({
      title: artwork?.title ?? "",
      subtitle: [artwork?.artistName, artwork?.year].filter(Boolean).join(", "),
    });
  }
  return parts;
}

/** All plaque text in one draw call per atlas page. */
function PlaqueText({
  labels,
  transforms,
}: {
  labels: PlaqueLabel[];
  transforms: THREE.Matrix4[];
}) {
  const built = useMemo(() => {
    const atlas = buildPlaqueAtlas(labels);
    if (!atlas) return null;
    return { atlas, geometries: buildPlaqueTextGeometries(atlas, transforms) };
  }, [labels, transforms]);
  useEffect(
    () => () => {
      if (!built) return;
      for (const t of built.atlas.textures) t.dispose();
      for (const g of built.geometries) g.dispose();
    },
    [built],
  );
  if (!built) return null;
  return built.geometries.map((geometry, page) => (
    // One geometry per atlas page
    <mesh key={page} geometry={geometry}>
      <meshBasicMaterial
        map={built.atlas.textures[page]}
        transparent
        depthWrite={false}
        alphaTest={0.02}
      />
    </mesh>
  ));
}

function MissingLabel({ painting, title }: { painting: PaintingLayout; title: string }) {
  const baked = useMemo(() => bakeMissingLabel(title), [title]);
  useEffect(() => () => baked?.texture.dispose(), [baked]);
  if (!baked) return null;
  const width = Math.min(painting.width * 0.85, 0.28 * baked.aspect);
  const lift = CANVAS_Z + 0.01;
  const [px, py, pz] = painting.position;
  return (
    <mesh
      geometry={UNIT_PLANE}
      position={[
        px + lift * Math.sin(painting.rotationY),
        py,
        pz + lift * Math.cos(painting.rotationY),
      ]}
      rotation-y={painting.rotationY}
      scale={[width, width / baked.aspect, 1]}
    >
      <meshBasicMaterial map={baked.texture} transparent depthWrite={false} />
    </mesh>
  );
}

/** One additive glow box parked on the hovered painting's frame. Only this
 * mesh animates on hover, so there is no per-painting frame loop. */
function FrameGlow({ frames }: { frames: THREE.Matrix4[] }) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const glow = useRef({ intensity: 0, index: -1 });
  const invalidate = useThree((s) => s.invalidate);

  useFrame((_, delta) => {
    const box = mesh.current;
    const mat = material.current;
    if (!box || !mat) return;
    const index = useMuseumStore.getState().hoveredIndex ?? -1;
    const state = glow.current;
    if (index < 0 && state.intensity === 0) return;

    if (index >= 0 && index !== state.index) {
      const frame = frames[index];
      if (frame) {
        frame.decompose(box.position, box.quaternion, box.scale);
        box.scale.addScalar(GLOW_PAD);
      }
      state.index = index;
    }
    const target = index >= 0 ? GLOW_TARGET : 0;
    state.intensity = THREE.MathUtils.damp(state.intensity, target, GLOW_DAMP, delta);
    if (Math.abs(state.intensity - target) < 0.001) state.intensity = target;
    mat.opacity = state.intensity;
    box.visible = state.intensity > 0;
    if (state.intensity !== target) invalidate();
  });

  return (
    <mesh ref={mesh} geometry={UNIT_BOX} visible={false}>
      <meshBasicMaterial
        ref={material}
        color={FRAME_GLOW_COLOR}
        transparent
        opacity={0}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  );
}

export function Paintings({
  world,
  artworkById,
}: {
  world: WorldLayout;
  artworkById: Map<string, ArtworkData>;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const parts = useMemo(() => buildPaintingParts(world, artworkById), [world, artworkById]);
  const materials = useMemo(
    () =>
      world.paintings.map(
        () =>
          new THREE.MeshStandardMaterial({
            map: loadingCanvasTexture(),
            roughness: 0.95,
            metalness: 0,
            envMapIntensity: 0.22,
          }),
      ),
    [world],
  );
  useEffect(
    () => () => {
      for (const m of materials) m.dispose();
    },
    [materials],
  );
  const [missing, setMissing] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    setMissing((prev) => (prev.size === 0 ? prev : new Set()));
    const streamer = new TextureStreamer({
      world,
      artworkById,
      materials,
      invalidate,
      onMissing: (index) =>
        setMissing((prev) => (prev.has(index) ? prev : new Set(prev).add(index))),
    });
    let dirty = false;
    const tick = () => {
      dirty = false;
      const s = useMuseumStore.getState();
      streamer.tick({
        player: s.player,
        roomIndex: s.roomIndex,
        hoveredIndex: s.hoveredIndex,
        inspectIndex: s.inspectPhase === "idle" ? null : s.inspectIndex,
      });
    };
    tick();
    // Hover and inspect change the protected set and must not wait for the
    // next tick; everything else (walking) is coalesced to 4 Hz.
    const unsubscribe = useMuseumStore.subscribe((s, prev) => {
      if (
        s.hoveredIndex !== prev.hoveredIndex ||
        s.inspectIndex !== prev.inspectIndex ||
        s.inspectPhase !== prev.inspectPhase
      ) {
        tick();
      } else {
        dirty = true;
      }
    });
    const interval = setInterval(() => {
      if (dirty) tick();
    }, STREAM_TICK_MS);
    return () => {
      unsubscribe();
      clearInterval(interval);
      streamer.dispose();
    };
  }, [world, artworkById, materials, invalidate]);

  const shadowTexture = getDropShadowTexture();

  return (
    <>
      {/* Standard (not physical) material: clearcoat is the single most
			    expensive built-in shader and the frame is the most-repeated lit
			    mesh; envMapIntensity keeps the lacquered sheen. */}
      <Instances geometry={UNIT_BOX} matrices={parts.antiqueFrames} castShadow>
        <meshStandardMaterial
          color={FRAME_ANTIQUE_COLOR}
          metalness={0.85}
          roughness={0.3}
          envMapIntensity={0.9}
        />
      </Instances>
      <Instances geometry={UNIT_BOX} matrices={parts.darkFrames} castShadow>
        <meshStandardMaterial
          color={FRAME_DARK_COLOR}
          metalness={0.2}
          roughness={0.4}
          envMapIntensity={0.9}
        />
      </Instances>
      <Instances geometry={UNIT_PLANE} matrices={parts.lips}>
        <meshStandardMaterial color={LIP_COLOR} roughness={1} />
      </Instances>
      {shadowTexture ? (
        <Instances geometry={UNIT_PLANE} matrices={parts.shadows}>
          <meshBasicMaterial map={shadowTexture} transparent depthWrite={false} opacity={0.85} />
        </Instances>
      ) : null}
      <Instances geometry={UNIT_PLANE} matrices={parts.plaques}>
        <meshStandardMaterial color={PLAQUE_COLOR} roughness={0.6} />
      </Instances>
      <PlaqueText labels={parts.labels} transforms={parts.plaqueTexts} />
      {/* Track-light housings; the warm spot they appear to cast comes from
			    the pooled lights in lights.tsx. */}
      <Instances geometry={TRACK_LIGHT_GEOMETRY} matrices={parts.housings}>
        <meshStandardMaterial color={HOUSING_COLOR} metalness={0.6} roughness={0.4} />
      </Instances>

      {world.paintings.map((p, i) => (
        <mesh
          // Paintings are static per world; the index disambiguates a work hung twice
          key={`${p.artworkId}:${i}`}
          geometry={UNIT_PLANE}
          material={materials[i]}
          position={parts.canvasPositions[i]}
          rotation-y={p.rotationY}
          scale={[p.width, p.height, 1]}
        />
      ))}
      {[...missing].map((i) => {
        const p = world.paintings[i];
        return p ? (
          <MissingLabel
            key={`${p.artworkId}:${i}`}
            painting={p}
            title={artworkById.get(p.artworkId)?.title ?? ""}
          />
        ) : null;
      })}
      <FrameGlow frames={parts.frames} />
    </>
  );
}
