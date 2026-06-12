import {
	Environment,
	Lightformer,
	MeshReflectorMaterial,
	Text,
} from "@react-three/drei";
import { useEffect, useRef } from "react";
import type * as THREE from "three";

import {
	DOOR_HEIGHT,
	DOOR_WIDTH,
	type PaintingLayout,
	WALL_THICKNESS,
	type WorldLayout,
} from "./layout";
import { Painting } from "./painting";
import type { GalleryContent } from "./types";

const LIGHT_COLORS = {
	warm: "#ffe2b8",
	neutral: "#fff3e2",
	cool: "#e8eeff",
} as const;

export function themeOf(content: GalleryContent) {
	const t = content.theme ?? {};
	return {
		wallColor: t.wallColor ?? "#857b6c",
		accentWallColor: t.accentWallColor ?? t.wallColor ?? "#6e6354",
		floorColor: t.floorColor ?? "#332b22",
		ambientIntensity: t.ambientIntensity ?? 1,
		lightColor:
			LIGHT_COLORS[(t.lightTemperature ?? "warm") as keyof typeof LIGHT_COLORS] ??
			LIGHT_COLORS.warm,
		background: "#0b0a09",
	};
}

function RoomShadowLight({
	x,
	z,
	height,
	color,
}: {
	x: number;
	z: number;
	height: number;
	color: string;
}) {
	const ref = useRef<THREE.SpotLight>(null);
	const targetRef = useRef<THREE.Object3D>(null);
	useEffect(() => {
		if (ref.current && targetRef.current) {
			ref.current.target = targetRef.current;
		}
	}, []);
	return (
		<>
			<spotLight
				ref={ref}
				position={[x, height - 0.15, z]}
				color={color}
				intensity={26}
				angle={1.05}
				penumbra={0.9}
				decay={1.6}
				castShadow
				shadow-mapSize={[1024, 1024]}
				shadow-bias={-0.0004}
			/>
			<object3D ref={targetRef} position={[x, 0, z]} />
		</>
	);
}

function Bench({ x, z }: { x: number; z: number }) {
	return (
		<group position={[x, 0, z]}>
			<mesh position={[0, 0.46, 0]} castShadow receiveShadow>
				<boxGeometry args={[2.2, 0.12, 0.62]} />
				<meshPhysicalMaterial
					color="#2b211a"
					roughness={0.45}
					clearcoat={0.5}
					clearcoatRoughness={0.4}
				/>
			</mesh>
			{[-0.9, 0.9].map((dx) => (
				<mesh key={dx} position={[dx, 0.2, 0]} castShadow>
					<boxGeometry args={[0.1, 0.4, 0.5]} />
					<meshStandardMaterial color="#15110d" roughness={0.6} metalness={0.5} />
				</mesh>
			))}
		</group>
	);
}

function DoorFrame({ z, color }: { z: number; color: string }) {
	const jambW = 0.18;
	const jambD = WALL_THICKNESS + 0.12;
	return (
		<group position={[0, 0, z]}>
			{[-1, 1].map((side) => (
				<mesh
					key={side}
					position={[side * (DOOR_WIDTH / 2 + jambW / 2 - 0.02), DOOR_HEIGHT / 2, 0]}
					castShadow
				>
					<boxGeometry args={[jambW, DOOR_HEIGHT, jambD]} />
					<meshStandardMaterial color={color} roughness={0.5} />
				</mesh>
			))}
			<mesh position={[0, DOOR_HEIGHT + 0.07, 0]} castShadow>
				<boxGeometry args={[DOOR_WIDTH + jambW * 2, 0.22, jambD]} />
				<meshStandardMaterial color={color} roughness={0.5} />
			</mesh>
		</group>
	);
}

export function GalleryScene({
	content,
	world,
	register,
}: {
	content: GalleryContent;
	world: WorldLayout;
	register: (mesh: THREE.Object3D | null, layout: PaintingLayout) => void;
}) {
	const theme = themeOf(content);
	const midZ = world.totalDepth / 2;

	return (
		<>
			<color attach="background" args={[theme.background]} />
			<fog
				attach="fog"
				args={[theme.background, 14, world.totalDepth + 34]}
			/>

			<hemisphereLight
				color={theme.wallColor}
				groundColor={theme.floorColor}
				intensity={0.5 * theme.ambientIntensity}
			/>

			{/* Procedural environment for frame glare / floor sheen — no
			    network fetch, just soft ceiling strips. */}
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

			{/* Reflective polished floor */}
			<mesh
				rotation={[-Math.PI / 2, 0, 0]}
				position={[0, 0, midZ]}
				receiveShadow
			>
				<planeGeometry
					args={[world.buildingWidth + 2, world.totalDepth + 2]}
				/>
				<MeshReflectorMaterial
					blur={[380, 90]}
					resolution={1024}
					mixBlur={1}
					mixStrength={48}
					roughness={0.82}
					depthScale={1.1}
					minDepthThreshold={0.4}
					maxDepthThreshold={1.3}
					color={theme.floorColor}
					metalness={0.35}
					mirror={0.55}
				/>
			</mesh>

			{/* Walls */}
			{world.walls.map((box, i) => (
				<mesh
					// biome-ignore lint/suspicious/noArrayIndexKey: static geometry
					key={i}
					position={box.position}
					castShadow
					receiveShadow
				>
					<boxGeometry args={box.size} />
					<meshStandardMaterial color={theme.wallColor} roughness={0.94} />
				</mesh>
			))}

			{/* Per-room ceiling, label, bench, key light, cove strips */}
			{world.rooms.map((room) => (
				<group key={room.id}>
					<mesh
						rotation={[Math.PI / 2, 0, 0]}
						position={[0, room.height, (room.minZ + room.maxZ) / 2]}
					>
						<planeGeometry args={[world.buildingWidth + 1, room.depth + 1]} />
						<meshStandardMaterial color="#1b1813" roughness={1} />
					</mesh>

					{/* LED cove strips along the side walls */}
					{[-1, 1].map((side) => (
						<mesh
							key={side}
							position={[
								side * (world.buildingWidth / 2 - WALL_THICKNESS / 2 - 0.06),
								room.height - 0.3,
								(room.minZ + room.maxZ) / 2,
							]}
						>
							<boxGeometry args={[0.05, 0.05, room.depth - 1.6]} />
							<meshStandardMaterial
								color={theme.lightColor}
								emissive={theme.lightColor}
								emissiveIntensity={2.2}
							/>
						</mesh>
					))}

					{/* Room name, high on the entrance wall */}
					<Text
						position={[
							0,
							Math.min(room.height - 0.85, DOOR_HEIGHT + 1.1),
							room.minZ + WALL_THICKNESS / 2 + 0.02,
						]}
						fontSize={0.34}
						letterSpacing={0.24}
						color="#d8cfbf"
						anchorX="center"
						anchorY="middle"
						fontWeight={600}
						maxWidth={world.buildingWidth - 4}
						textAlign="center"
					>
						{room.name.toUpperCase()}
					</Text>

					{room.depth >= 10 ? (
						<Bench x={0} z={(room.minZ + room.maxZ) / 2} />
					) : null}

					<RoomShadowLight
						x={0}
						z={(room.minZ + room.maxZ) / 2}
						height={room.height}
						color={theme.lightColor}
					/>
				</group>
			))}

			{/* Doorway frames */}
			{world.doorways.map((d) => (
				<DoorFrame key={d.z} z={d.z} color="#191510" />
			))}

			{/* Paintings */}
			{world.paintings.map((p) => (
				<Painting
					key={p.artwork.id + p.roomIndex}
					layout={p}
					ceilingHeight={world.rooms[p.roomIndex]?.height ?? 5}
					lightColor={theme.lightColor}
					register={register}
				/>
			))}
		</>
	);
}
