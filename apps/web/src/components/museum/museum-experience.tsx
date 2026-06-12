import { useProgress } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { GalleryScene } from "./gallery-scene";
import {
	buildWorldLayout,
	type PaintingLayout,
} from "./layout";
import { InspectPanel } from "./inspect-panel";
import { PlayerRig } from "./player-rig";
import { useMuseumStore } from "./store";
import type { GalleryContent } from "./types";

function requestWalk() {
	window.dispatchEvent(new Event("museum:lock"));
}

function Crosshair() {
	const locked = useMuseumStore((s) => s.locked);
	const hovered = useMuseumStore((s) => s.hovered);
	if (!locked) return null;
	return (
		<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
			<div
				className={`rounded-full border transition-all duration-200 ${
					hovered
						? "h-5 w-5 border-[#e9d9ad]"
						: "h-1.5 w-1.5 border-white/60 bg-white/40"
				}`}
			/>
		</div>
	);
}

function HoverTitle() {
	const hovered = useMuseumStore((s) => s.hovered);
	const locked = useMuseumStore((s) => s.locked);
	return (
		<div
			className={`pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center transition-all duration-300 ${
				hovered && locked ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
			}`}
		>
			<div className="rounded-full border border-white/10 bg-black/55 px-5 py-2.5 text-center backdrop-blur">
				<p className="font-museum text-lg leading-tight text-[#f1ead9]">
					{hovered?.artwork.title}
				</p>
				<p className="text-[11px] uppercase tracking-[0.22em] text-white/50">
					{hovered?.artwork.artistName} — click to inspect
				</p>
			</div>
		</div>
	);
}

function RoomIndicator({ content }: { content: GalleryContent }) {
	const roomIndex = useMuseumStore((s) => s.roomIndex);
	const locked = useMuseumStore((s) => s.locked);
	const room = content.rooms.filter((r) => r.artworks.length > 0)[roomIndex];
	return (
		<div
			className={`pointer-events-none absolute left-6 top-6 z-10 transition-opacity duration-500 ${
				locked ? "opacity-100" : "opacity-0"
			}`}
		>
			<p className="text-[10px] uppercase tracking-[0.3em] text-white/45">
				{content.name}
			</p>
			<p className="font-museum mt-1 text-2xl text-[#ece5d3]">
				{room?.name ?? ""}
			</p>
		</div>
	);
}

function ControlsHint() {
	const locked = useMuseumStore((s) => s.locked);
	const [expired, setExpired] = useState(false);
	useEffect(() => {
		if (!locked) return;
		const t = setTimeout(() => setExpired(true), 7000);
		return () => clearTimeout(t);
	}, [locked]);
	return (
		<div
			className={`pointer-events-none absolute bottom-6 right-6 z-10 text-right text-[11px] leading-5 text-white/45 transition-opacity duration-700 ${
				locked && !expired ? "opacity-100" : "opacity-0"
			}`}
		>
			<p>WASD — walk · Shift — stride</p>
			<p>Mouse — look · Click — inspect · Esc — pause</p>
		</div>
	);
}

function EnterOverlay({
	content,
	entered,
}: {
	content: GalleryContent;
	entered: boolean;
}) {
	const locked = useMuseumStore((s) => s.locked);
	const phase = useMuseumStore((s) => s.inspectPhase);
	const { progress, active } = useProgress();
	if (locked || phase !== "idle") return null;

	if (entered) {
		return (
			<button
				type="button"
				onClick={requestWalk}
				className="absolute inset-0 z-20 flex w-full cursor-pointer flex-col items-center justify-center bg-black/35 backdrop-blur-[2px] transition-opacity"
			>
				<p className="font-museum text-3xl text-[#efe8d6]">Paused</p>
				<p className="mt-3 text-[12px] uppercase tracking-[0.28em] text-white/55">
					Click to continue walking
				</p>
			</button>
		);
	}

	const roomsWithArt = content.rooms.filter((r) => r.artworks.length > 0);
	const artworkCount = roomsWithArt.reduce(
		(acc, r) => acc + r.artworks.length,
		0,
	);

	return (
		<div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gradient-to-b from-black/70 via-black/55 to-black/80 px-6 text-center">
			<p className="text-[11px] uppercase tracking-[0.34em] text-[#b7a989]">
				{content.tagline ?? "A walkable gallery"}
			</p>
			<h1 className="font-museum mt-4 max-w-3xl text-6xl leading-[1.02] text-[#f4efe3] md:text-7xl">
				{content.name}
			</h1>
			{content.description ? (
				<p className="mt-6 max-w-xl text-[15px] leading-relaxed text-white/65">
					{content.description}
				</p>
			) : null}
			<p className="mt-5 text-[11px] uppercase tracking-[0.24em] text-white/40">
				{roomsWithArt.length} {roomsWithArt.length === 1 ? "room" : "rooms"} ·{" "}
				{artworkCount} artworks
			</p>
			<button
				type="button"
				onClick={requestWalk}
				className="group mt-10 rounded-full border border-[#cbb87f]/60 bg-[#cbb87f]/10 px-10 py-4 text-[13px] uppercase tracking-[0.3em] text-[#e9dcb4] transition-all hover:bg-[#cbb87f]/25 hover:tracking-[0.36em]"
			>
				{active ? `Preparing ${Math.round(progress)}%` : "Enter the gallery"}
			</button>
			<p className="mt-6 text-[11px] text-white/35">
				WASD to walk · mouse to look · click a painting to inspect
			</p>
			<Link
				to="/museum"
				className="mt-10 text-[11px] uppercase tracking-[0.24em] text-white/40 underline-offset-4 transition-colors hover:text-white/80 hover:underline"
			>
				← Back to the lobby
			</Link>
		</div>
	);
}

export function MuseumExperience({ content }: { content: GalleryContent }) {
	const world = useMemo(() => buildWorldLayout(content), [content]);
	const registryRef = useRef(new Map<THREE.Object3D, PaintingLayout>());
	const [entered, setEntered] = useState(false);
	const locked = useMuseumStore((s) => s.locked);

	useEffect(() => {
		if (locked) setEntered(true);
	}, [locked]);

	// Reset shared store when switching galleries.
	useEffect(() => {
		return () => {
			useMuseumStore.setState({
				locked: false,
				hovered: null,
				inspected: null,
				inspectPhase: "idle",
				roomIndex: 0,
			});
		};
	}, []);

	const register = useCallback(
		(mesh: THREE.Object3D | null, layout: PaintingLayout) => {
			if (mesh) {
				registryRef.current.set(mesh, layout);
			} else {
				for (const [key, value] of registryRef.current) {
					if (value === layout) registryRef.current.delete(key);
				}
			}
		},
		[],
	);

	if (world.paintings.length === 0) {
		return (
			<div className="flex h-screen flex-col items-center justify-center bg-[#0b0a09] px-6 text-center">
				<p className="font-museum text-4xl text-[#e8e2d5]">
					The walls are bare
				</p>
				<p className="mt-4 max-w-md text-sm leading-relaxed text-white/50">
					This gallery has no published artworks yet. Check back when the
					curators have finished hanging the collection.
				</p>
				<Link
					to="/museum"
					className="mt-8 rounded-full border border-white/20 px-6 py-2.5 text-[12px] uppercase tracking-[0.24em] text-white/70 transition-colors hover:border-white/50 hover:text-white"
				>
					Back to the lobby
				</Link>
			</div>
		);
	}

	return (
		<div className="relative h-screen w-full select-none overflow-hidden bg-[#0b0a09]">
			<Canvas
				shadows={{ enabled: true, type: THREE.PCFShadowMap }}
				camera={{ fov: 70, near: 0.1, far: 220 }}
				dpr={[1, 1.75]}
				gl={{
					antialias: true,
					toneMapping: THREE.ACESFilmicToneMapping,
					toneMappingExposure: 1.12,
					powerPreference: "high-performance",
				}}
			>
				<GalleryScene content={content} world={world} register={register} />
				<PlayerRig world={world} registry={registryRef.current} />
			</Canvas>

			<Crosshair />
			<HoverTitle />
			<RoomIndicator content={content} />
			<ControlsHint />
			<InspectPanel />
			<EnterOverlay content={content} entered={entered} />
		</div>
	);
}

export default MuseumExperience;
