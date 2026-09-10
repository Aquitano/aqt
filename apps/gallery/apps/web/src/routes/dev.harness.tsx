import { createFileRoute, notFound } from "@tanstack/react-router";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import type { FrameStats } from "@/components/museum/museum-experience";
import type { AutopilotPose } from "@/components/museum/renderer/player-rig";
import { useMuseumStore } from "@/components/museum/store";
import type { ArtworkData, GalleryContent } from "@/components/museum/types";

import "@/components/museum/museum.css";

const MuseumExperience = lazy(
	() => import("@/components/museum/museum-experience"),
);

type HarnessSearch = {
	rooms: number;
	works: number;
	seed: string;
	auto: boolean;
	curated: boolean;
	x?: number;
	z?: number;
	yaw?: number;
};

const num = (v: unknown) => {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : undefined;
};
const flag = (v: unknown) => v === 1 || v === "1" || v === true || v === "true";

/** Synthetic-content renderer harness for performance and screenshot work.
 * `/dev/harness?rooms=6&works=24&seed=x&auto=1&x=&z=&yaw=&curated=1`. */
export const Route = createFileRoute("/dev/harness")({
	component: HarnessPage,
	validateSearch: (search: Record<string, unknown>): HarnessSearch => ({
		rooms: Math.max(1, Math.round(num(search.rooms) ?? 6)),
		works: Math.max(1, Math.round(num(search.works) ?? 24)),
		seed:
			typeof search.seed === "string" && search.seed ? search.seed : "harness",
		auto: flag(search.auto),
		curated: flag(search.curated),
		x: num(search.x),
		z: num(search.z),
		yaw: num(search.yaw),
	}),
	loader: () => {
		if (!import.meta.env.DEV) throw notFound();
	},
	head: () => ({
		meta: [
			{ title: "Renderer harness — AQT Gallery" },
			{ name: "robots", content: "noindex" },
		],
	}),
});

function hashSeed(seed: string) {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	}
	return h >>> 0;
}

function mulberry32(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ROOM_NAMES = [
	"Entrance Hall",
	"The Long Gallery",
	"Cabinet of Light",
	"North Wing",
	"The Blue Room",
	"Salon des Refusés",
	"Atrium",
	"Study Collection",
];
const ARTISTS = [
	"Johannes Vermeer",
	"Artemisia Gentileschi",
	"Caspar David Friedrich",
	"Berthe Morisot",
	"Hilma af Klint",
	"Egon Schiele",
	"Agnes Martin",
	"Paul Klee",
	"Sofonisba Anguissola",
	"Helen Frankenthaler",
];
const TITLE_HEADS = [
	"Study of",
	"Portrait of",
	"View toward",
	"Interior with",
	"Landscape near",
	"Still Life with",
	"Allegory of",
];
const TITLE_TAILS = [
	"a Window",
	"the Harbour",
	"Two Figures",
	"the Evening",
	"Lemons",
	"a Storm",
	"Silence",
	"the North Sea",
	"Autumn",
	"the Studio",
];
const MEDIA = [
	"Oil on canvas",
	"Oil on panel",
	"Tempera on wood",
	"Watercolour on paper",
	"Acrylic on linen",
	"Gouache on board",
];
const WALLS = ["north", "east", "south", "west"] as const;

const picsum = (seed: string, i: number, w: number, h: number) =>
	`https://picsum.photos/seed/${seed}-${i}/${w}/${h}`;

const pick = <T,>(items: readonly T[], r: number): T =>
	items[Math.min(items.length - 1, Math.floor(r * items.length))] as T;

function buildHarnessContent(search: HarnessSearch): GalleryContent {
	const rng = mulberry32(hashSeed(search.seed));
	const rooms: GalleryContent["rooms"] = Array.from(
		{ length: search.rooms },
		(_, i) => ({
			id: `room-${i}`,
			name:
				i < ROOM_NAMES.length
					? (ROOM_NAMES[i] as string)
					: `${ROOM_NAMES[i % ROOM_NAMES.length]} ${Math.floor(i / ROOM_NAMES.length) + 1}`,
			description: null,
			layout: null,
			artworks: [],
		}),
	);

	for (let i = 0; i < search.works; i++) {
		const room = rooms[Math.floor((i * search.rooms) / search.works)];
		if (!room) continue;
		const heightCm = 40 + rng() * 140;
		const widthCm = heightCm * (0.6 + rng() * 1.1);
		const year = 1600 + Math.floor(rng() * 381);
		const pxW = 1200;
		const pxH = Math.round((pxW * heightCm) / widthCm);
		const artwork: ArtworkData = {
			id: `work-${i}`,
			title: `${pick(TITLE_HEADS, rng())} ${pick(TITLE_TAILS, rng())}`,
			artistName: pick(ARTISTS, rng()),
			artist: null,
			year: String(year),
			medium: pick(MEDIA, rng()),
			dimensions: `${heightCm.toFixed(1)} × ${widthCm.toFixed(1)} cm`,
			imageUrl: picsum(search.seed, i, pxW, pxH),
			midUrl: picsum(
				search.seed,
				i,
				1024,
				Math.round((1024 * heightCm) / widthCm),
			),
			thumbnailUrl: picsum(
				search.seed,
				i,
				480,
				Math.round((480 * heightCm) / widthCm),
			),
			imageWidth: pxW,
			imageHeight: pxH,
			placement: {
				position: room.artworks.length,
				wall:
					search.curated && i % 3 === 0
						? (WALLS[i % WALLS.length] ?? null)
						: null,
				wallOffset: null,
				scale: null,
				note: null,
			},
		};
		room.artworks.push(artwork);
	}

	return {
		id: `harness-${search.seed}-${search.rooms}-${search.works}-${search.curated ? "c" : "a"}`,
		slug: "harness",
		name: "Renderer Harness",
		tagline: "Synthetic gallery for renderer work",
		description: null,
		theme: { lightTemperature: "warm" },
		rooms,
	};
}

/** Page-level frame rate plus the live room/painting counts. The rAF cadence
 * is the display rate while the renderer keeps up and drops with it when the
 * GPU or the main thread falls behind. */
declare global {
	interface Window {
		__museumStats?: FrameStats;
	}
}

function PerfOverlay({ frame }: { frame: FrameStats | null }) {
	const [fps, setFps] = useState(0);
	const world = useMuseumStore((s) => s.world);
	const roomIndex = useMuseumStore((s) => s.roomIndex);
	const player = useMuseumStore((s) => s.player);

	useEffect(() => {
		let frames = 0;
		let last = performance.now();
		let raf = 0;
		const tick = (now: number) => {
			frames += 1;
			if (now - last >= 500) {
				setFps(Math.round((frames * 1000) / (now - last)));
				frames = 0;
				last = now;
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);

	return (
		<div
			data-harness-stats
			className="pointer-events-none fixed bottom-4 left-4 z-[60] rounded border border-white/10 bg-black/60 px-3 py-2 font-mono text-[11px] text-white/80 leading-5 backdrop-blur"
		>
			<p>{fps} fps</p>
			<p>
				{world?.rooms.length ?? 0} rooms · {world?.paintings.length ?? 0}{" "}
				paintings
			</p>
			<p data-harness-frame>
				{frame
					? `${frame.drawCalls} draw calls · ${frame.lights} lights · ${frame.triangles} tris`
					: "no frame yet"}
			</p>
			<p>
				room {roomIndex} · x {player.x.toFixed(1)} z {player.z.toFixed(1)} yaw{" "}
				{player.angle.toFixed(2)}
			</p>
		</div>
	);
}

function HarnessPage() {
	const search = Route.useSearch();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const [frame, setFrame] = useState<FrameStats | null>(null);
	const lastFrameAt = useRef(0);
	const onFrameStats = useCallback((stats: FrameStats) => {
		window.__museumStats = stats;
		const now = performance.now();
		if (now - lastFrameAt.current < 500) return;
		lastFrameAt.current = now;
		setFrame(stats);
	}, []);

	const content = useMemo(() => buildHarnessContent(search), [search]);
	const autopilot = useMemo<AutopilotPose | undefined>(
		() =>
			search.auto || search.x !== undefined || search.z !== undefined
				? { x: search.x, z: search.z, yaw: search.yaw }
				: undefined,
		[search.auto, search.x, search.z, search.yaw],
	);

	if (!mounted) return <div className="h-screen bg-[#0b0a09]" />;

	return (
		<Suspense fallback={<div className="h-screen bg-[#0b0a09]" />}>
			<MuseumExperience
				key={content.id}
				content={content}
				autopilot={autopilot}
				onFrameStats={onFrameStats}
			/>
			<PerfOverlay frame={frame} />
		</Suspense>
	);
}
