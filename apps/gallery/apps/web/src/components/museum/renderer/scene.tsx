import type { WorldLayout } from "@aqt-gallery/gallery-layout";
import { Environment, Lightformer } from "@react-three/drei";
import { useEffect, useMemo } from "react";

import type { ResolvedTheme } from "../theme";
import type { ArtworkData } from "../types";
import { buildArchitecture, type RoomLabelPlacement } from "./architecture";
import {
	BENCH_LEG_COLOR,
	BENCH_TOP_COLOR,
	CEILING_COLOR,
	DOORFRAME_COLOR,
	FOG_FAR,
	FOG_NEAR,
} from "./constants";
import { Instances, UNIT_BOX, UNIT_PLANE } from "./instanced";
import { AccentLights, RoomShadowLight, ScenePrewarm } from "./lights";
import { Paintings } from "./paintings";
import { bakeRoomLabel } from "./text-atlas";

const ROOM_LABEL_HEIGHT = 0.42;

/** Room names, one baked texture each, high on a door-free wall. */
function RoomLabels({ placements }: { placements: RoomLabelPlacement[] }) {
	const baked = useMemo(
		() => placements.map((p) => bakeRoomLabel(p.room.name)),
		[placements],
	);
	useEffect(
		() => () => {
			for (const label of baked) label?.texture.dispose();
		},
		[baked],
	);
	return placements.map((p, i) => {
		const label = baked[i];
		if (!label) return null;
		let height = ROOM_LABEL_HEIGHT;
		let width = height * label.aspect;
		if (width > p.maxWidth) {
			width = p.maxWidth;
			height = width / label.aspect;
		}
		return (
			<mesh
				key={`${p.room.id}:${p.room.index}`}
				geometry={UNIT_PLANE}
				position={p.position}
				rotation-y={p.rotationY}
				scale={[width, height, 1]}
			>
				<meshBasicMaterial map={label.texture} transparent depthWrite={false} />
			</mesh>
		);
	});
}

export function GalleryScene({
	world,
	artworkById,
	theme,
}: {
	world: WorldLayout;
	artworkById: Map<string, ArtworkData>;
	theme: ResolvedTheme;
}) {
	const architecture = useMemo(() => buildArchitecture(world), [world]);

	return (
		<>
			<color attach="background" args={[theme.background]} />
			{/* Fog to the background colour plus the rig's far plane bound what
			    renders each frame to roughly two rooms, however large the museum. */}
			<fog attach="fog" args={[theme.background, FOG_NEAR, FOG_FAR]} />

			<hemisphereLight
				color={theme.wallColor}
				groundColor={theme.floorColor}
				intensity={0.5 * theme.ambientIntensity}
			/>

			{/* Procedural environment for frame glare and floor sheen: no network
			    fetch, just soft ceiling strips rendered once. */}
			<Environment resolution={64} frames={1}>
				<Lightformer
					form="rect"
					intensity={2.4}
					color={theme.lightColor}
					position={[0, 6, 0]}
					rotation={[Math.PI / 2, 0, 0]}
					scale={[8, 40, 1]}
				/>
				<Lightformer
					form="rect"
					intensity={0.8}
					color="#ffffff"
					position={[-8, 3, 0]}
					rotation={[0, Math.PI / 2, 0]}
					scale={[30, 3, 1]}
				/>
				<Lightformer
					form="rect"
					intensity={0.8}
					color="#ffffff"
					position={[8, 3, 0]}
					rotation={[0, -Math.PI / 2, 0]}
					scale={[30, 3, 1]}
				/>
			</Environment>

			{/* Polished floor: a static env-lit material instead of a reflector,
			    so the sheen is GPU-only and costs nothing per frame. */}
			<Instances
				geometry={UNIT_PLANE}
				matrices={architecture.floors}
				receiveShadow
			>
				<meshStandardMaterial
					color={theme.floorColor}
					roughness={Math.min(theme.floorRoughness, 0.4)}
					metalness={0.1}
					envMapIntensity={0.6}
				/>
			</Instances>
			<Instances
				geometry={UNIT_BOX}
				matrices={architecture.walls}
				castShadow
				receiveShadow
			>
				<meshStandardMaterial color={theme.wallColor} roughness={0.94} />
			</Instances>
			<Instances geometry={UNIT_PLANE} matrices={architecture.ceilings}>
				<meshStandardMaterial color={CEILING_COLOR} roughness={1} />
			</Instances>
			<Instances geometry={UNIT_BOX} matrices={architecture.coves}>
				<meshStandardMaterial
					color={theme.lightColor}
					emissive={theme.lightColor}
					emissiveIntensity={1.6}
				/>
			</Instances>
			<Instances geometry={UNIT_BOX} matrices={architecture.jambs} castShadow>
				<meshStandardMaterial color={DOORFRAME_COLOR} roughness={0.5} />
			</Instances>
			<Instances geometry={UNIT_BOX} matrices={architecture.lintels} castShadow>
				<meshStandardMaterial color={DOORFRAME_COLOR} roughness={0.5} />
			</Instances>
			<Instances
				geometry={UNIT_BOX}
				matrices={architecture.benchTops}
				castShadow
				receiveShadow
			>
				<meshStandardMaterial
					color={BENCH_TOP_COLOR}
					roughness={0.45}
					metalness={0.2}
					envMapIntensity={0.7}
				/>
			</Instances>
			<Instances
				geometry={UNIT_BOX}
				matrices={architecture.benchLegs}
				castShadow
			>
				<meshStandardMaterial
					color={BENCH_LEG_COLOR}
					roughness={0.6}
					metalness={0.5}
				/>
			</Instances>

			<RoomLabels placements={architecture.roomLabels} />
			<Paintings world={world} artworkById={artworkById} />

			<AccentLights world={world} color={theme.lightColor} />
			<RoomShadowLight world={world} color={theme.lightColor} />
			<ScenePrewarm />
		</>
	);
}
