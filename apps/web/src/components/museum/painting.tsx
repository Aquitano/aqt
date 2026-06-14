import { Text, useTexture } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import {
	Component,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useRef,
} from "react";
import * as THREE from "three";

import type { PaintingLayout } from "./layout";
import { useMuseumStore } from "./store";

const FRAME_BORDER = 0.085;
const FRAME_DEPTH = 0.075;
const CANVAS_LIFT = 0.052;

/** Shared radial-gradient texture faking the soft drop shadow a hung
 * frame throws on the wall — far cheaper than 20+ shadow-casting lights. */
let dropShadowTexture: THREE.Texture | null = null;
function getDropShadowTexture() {
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

class TextureBoundary extends Component<
	{ fallback: ReactNode; children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function PaintingImage({
	url,
	width,
	height,
}: {
	url: string;
	width: number;
	height: number;
}) {
	const texture = useTexture(url);
	useEffect(() => {
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.anisotropy = 8;
		texture.needsUpdate = true;
	}, [texture]);
	return (
		<mesh position={[0, 0, CANVAS_LIFT]}>
			<planeGeometry args={[width, height]} />
			<meshStandardMaterial
				map={texture}
				roughness={0.82}
				metalness={0}
				envMapIntensity={0.22}
			/>
		</mesh>
	);
}

function MissingImage({
	width,
	height,
	title,
}: {
	width: number;
	height: number;
	title: string;
}) {
	return (
		<group position={[0, 0, CANVAS_LIFT]}>
			<mesh>
				<planeGeometry args={[width, height]} />
				<meshStandardMaterial color="#26231f" roughness={0.95} />
			</mesh>
			<Text
				position={[0, 0, 0.01]}
				fontSize={Math.min(0.09, width / 10)}
				maxWidth={width * 0.85}
				textAlign="center"
				color="#8d857a"
				anchorX="center"
				anchorY="middle"
			>
				{title}
				{"\n"}— image unavailable —
			</Text>
		</group>
	);
}

function LoadingCanvas({ width, height }: { width: number; height: number }) {
	return (
		<mesh position={[0, 0, CANVAS_LIFT]}>
			<planeGeometry args={[width, height]} />
			<meshStandardMaterial color="#494439" roughness={0.95} />
		</mesh>
	);
}

export function Painting({
	layout,
	ceilingHeight,
	lightColor,
	register,
}: {
	layout: PaintingLayout;
	ceilingHeight: number;
	lightColor: string;
	register: (mesh: THREE.Object3D | null, layout: PaintingLayout) => void;
}) {
	const { artwork, width, height } = layout;
	const frameRef = useRef<THREE.MeshPhysicalMaterial>(null);
	const hitRef = useRef<THREE.Mesh>(null);
	const spotRef = useRef<THREE.SpotLight>(null);
	const targetRef = useRef<THREE.Object3D>(null);

	useEffect(() => {
		register(hitRef.current, layout);
		return () => register(null, layout);
	}, [register, layout]);

	useEffect(() => {
		if (spotRef.current && targetRef.current) {
			spotRef.current.target = targetRef.current;
		}
	}, []);

	// Subtle frame glow when this painting is under the crosshair.
	useFrame((_, delta) => {
		const mat = frameRef.current;
		if (!mat) return;
		const hovered = useMuseumStore.getState().hovered === layout;
		const target = hovered ? 0.32 : 0;
		mat.emissiveIntensity = THREE.MathUtils.damp(
			mat.emissiveIntensity,
			target,
			12,
			delta,
		);
	});

	const isAntique = useMemo(() => {
		const y = Number.parseInt(artwork.year ?? "", 10);
		return Number.isFinite(y) && y < 1800;
	}, [artwork.year]);

	const frameW = width + FRAME_BORDER * 2;
	const frameH = height + FRAME_BORDER * 2;
	const shadowTex = getDropShadowTexture();

	// Spotlight hangs from the ceiling, pulled into the room along the
	// wall normal, aimed at the canvas center.
	const lightLocal: [number, number, number] = [
		0,
		ceilingHeight - 0.12 - layout.position[1],
		2.1,
	];
	const distToPainting = Math.hypot(lightLocal[1], lightLocal[2] - CANVAS_LIFT);
	const halfDiag = Math.hypot(frameW, frameH) / 2;
	const angle = THREE.MathUtils.clamp(
		Math.atan2(halfDiag * 1.25, distToPainting),
		0.22,
		0.85,
	);

	return (
		<group position={layout.position} rotation={[0, layout.rotationY, 0]}>
			{/* Fake soft drop shadow on the wall */}
			{shadowTex ? (
				<mesh position={[0.04, -0.06, 0.006]}>
					<planeGeometry args={[frameW * 1.5, frameH * 1.5]} />
					<meshBasicMaterial
						map={shadowTex}
						transparent
						depthWrite={false}
						opacity={0.85}
					/>
				</mesh>
			) : null}

			{/* Frame */}
			<mesh position={[0, 0, FRAME_DEPTH / 2]} castShadow>
				<boxGeometry args={[frameW, frameH, FRAME_DEPTH]} />
				<meshPhysicalMaterial
					ref={frameRef}
					color={isAntique ? "#a07d36" : "#241a12"}
					metalness={isAntique ? 0.85 : 0.15}
					roughness={isAntique ? 0.32 : 0.42}
					clearcoat={0.7}
					clearcoatRoughness={0.25}
					emissive="#d8b35a"
					emissiveIntensity={0}
					envMapIntensity={0.9}
				/>
			</mesh>
			{/* Inner lip — slightly recessed dark slot the canvas sits in */}
			<mesh position={[0, 0, FRAME_DEPTH - 0.012]}>
				<planeGeometry args={[width + 0.02, height + 0.02]} />
				<meshStandardMaterial color="#0c0a08" roughness={1} />
			</mesh>

			{/* The artwork itself (suspends while the image streams in) */}
			<group position={[0, 0, FRAME_DEPTH - CANVAS_LIFT + 0.046]}>
				{artwork.imageUrl ? (
					<TextureBoundary
						fallback={
							<MissingImage
								width={width}
								height={height}
								title={artwork.title}
							/>
						}
					>
						<Suspense
							fallback={<LoadingCanvas width={width} height={height} />}
						>
							<PaintingImage
								url={artwork.imageUrl}
								width={width}
								height={height}
							/>
						</Suspense>
					</TextureBoundary>
				) : (
					<MissingImage width={width} height={height} title={artwork.title} />
				)}
			</group>

			{/* Invisible hit target (slightly padded for easier aiming) */}
			<mesh ref={hitRef} position={[0, 0, FRAME_DEPTH / 2]} visible={false}>
				<boxGeometry args={[frameW + 0.15, frameH + 0.15, FRAME_DEPTH + 0.1]} />
				<meshBasicMaterial />
			</mesh>

			{/* Wall plaque */}
			<group
				position={[frameW / 2 + 0.32, -Math.max(0.18, height / 2 - 0.5), 0.01]}
			>
				<mesh>
					<planeGeometry args={[0.42, 0.18]} />
					<meshStandardMaterial color="#d9d2c4" roughness={0.6} />
				</mesh>
				<Text
					position={[0, 0.025, 0.004]}
					fontSize={0.028}
					maxWidth={0.36}
					color="#23201b"
					anchorX="center"
					anchorY="middle"
					fontWeight={700}
				>
					{artwork.title}
				</Text>
				<Text
					position={[0, -0.045, 0.004]}
					fontSize={0.022}
					maxWidth={0.36}
					color="#4d463c"
					anchorX="center"
					anchorY="middle"
				>
					{[artwork.artistName, artwork.year].filter(Boolean).join(", ")}
				</Text>
			</group>

			{/* Track light: housing + warm spot aimed at the canvas */}
			<group position={lightLocal}>
				<mesh rotation={[Math.PI / 4, 0, 0]} position={[0, 0.05, 0]}>
					<cylinderGeometry args={[0.055, 0.075, 0.22, 16]} />
					<meshStandardMaterial
						color="#15130f"
						metalness={0.6}
						roughness={0.4}
					/>
				</mesh>
				<spotLight
					ref={spotRef}
					color={lightColor}
					intensity={42}
					distance={0}
					angle={angle}
					penumbra={0.65}
					decay={2}
				/>
			</group>
			<object3D ref={targetRef} position={[0, 0, CANVAS_LIFT]} />
		</group>
	);
}
