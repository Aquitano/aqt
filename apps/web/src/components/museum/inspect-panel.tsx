import { X } from "lucide-react";
import { useEffect } from "react";

import { useMuseumStore } from "./store";

/** Right-side detail panel shown while a painting is inspected.
 * The 3D camera has already glided up to the canvas; this overlays
 * the metadata without leaving the scene. */
export function InspectPanel() {
	const inspected = useMuseumStore((s) => s.inspected);
	const phase = useMuseumStore((s) => s.inspectPhase);
	const closeInspect = useMuseumStore((s) => s.closeInspect);

	const visible = phase === "open";
	const mounted = phase === "open" || phase === "approaching";

	useEffect(() => {
		if (!mounted) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && useMuseumStore.getState().inspectPhase === "open") {
				closeInspect();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [mounted, closeInspect]);

	if (!mounted || !inspected) return null;
	const a = inspected.artwork;
	const facts = (a.funFacts ?? []).filter(Boolean);

	return (
		<div className="absolute inset-0 z-30 flex justify-end">
			{/* Click-catcher over the 3D view closes the inspect */}
			<button
				type="button"
				aria-label="Back to gallery"
				className="h-full flex-1 cursor-zoom-out bg-transparent"
				onClick={() => visible && closeInspect()}
			/>
			<aside
				className={`relative flex h-full w-full max-w-[420px] flex-col overflow-y-auto border-l border-white/10 bg-[#0e0d0bf2] px-8 py-10 text-[#e8e2d5] backdrop-blur-md transition-all duration-500 ${
					visible ? "translate-x-0 opacity-100" : "translate-x-10 opacity-0"
				}`}
			>
				<button
					type="button"
					onClick={() => closeInspect()}
					className="absolute right-5 top-5 rounded-full border border-white/15 p-2 text-white/70 transition-colors hover:border-white/40 hover:text-white"
					aria-label="Close inspection"
				>
					<X size={16} />
				</button>

				<p className="text-[11px] uppercase tracking-[0.28em] text-[#b7a989]">
					{[a.artistName, a.year].filter(Boolean).join(" · ")}
				</p>
				<h2 className="font-museum mt-3 text-4xl leading-[1.05] text-[#f4efe3]">
					{a.title}
				</h2>

				<div className="mt-4 flex flex-wrap gap-2 text-[11px] text-white/55">
					{a.medium ? (
						<span className="rounded-full border border-white/12 px-3 py-1">
							{a.medium}
						</span>
					) : null}
					{a.dimensions ? (
						<span className="rounded-full border border-white/12 px-3 py-1">
							{a.dimensions}
						</span>
					) : null}
				</div>

				{a.description ? (
					<p className="mt-6 text-[15px] leading-relaxed text-white/80">
						{a.description}
					</p>
				) : null}

				{a.story ? (
					<div className="mt-7">
						<h3 className="text-[11px] uppercase tracking-[0.28em] text-[#b7a989]">
							The story
						</h3>
						<p className="mt-2.5 text-[14px] leading-relaxed text-white/70">
							{a.story}
						</p>
					</div>
				) : null}

				{facts.length > 0 ? (
					<div className="mt-7">
						<h3 className="text-[11px] uppercase tracking-[0.28em] text-[#b7a989]">
							Worth knowing
						</h3>
						<ul className="mt-2.5 space-y-2.5">
							{facts.map((fact) => (
								<li
									key={fact}
									className="flex gap-2.5 text-[13.5px] leading-relaxed text-white/70"
								>
									<span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#b7a989]" />
									{fact}
								</li>
							))}
						</ul>
					</div>
				) : null}

				{a.artist?.bio ? (
					<div className="mt-7 border-t border-white/10 pt-6">
						<h3 className="text-[11px] uppercase tracking-[0.28em] text-[#b7a989]">
							{a.artist.name}
							{a.artist.birthYear
								? `, ${a.artist.birthYear}–${a.artist.deathYear ?? ""}`
								: ""}
						</h3>
						<p className="mt-2.5 text-[13.5px] leading-relaxed text-white/60">
							{a.artist.bio}
						</p>
					</div>
				) : null}

				<button
					type="button"
					onClick={() => closeInspect()}
					className="mt-9 self-start rounded-full border border-[#b7a989]/50 px-5 py-2 text-[12px] uppercase tracking-[0.2em] text-[#d8cba8] transition-colors hover:bg-[#b7a989]/10"
				>
					Back to gallery
				</button>
			</aside>
		</div>
	);
}
