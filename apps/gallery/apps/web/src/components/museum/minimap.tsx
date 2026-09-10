import { FloorPlan } from "./floor-plan";
import { useMuseumStore } from "./store";

/** Top-right minimap with click/tap-to-teleport. The rig snaps the pick to a
 * walkable spot inside the chosen room. */
export function Minimap() {
	const world = useMuseumStore((s) => s.world);
	const entered = useMuseumStore((s) => s.entered);
	const player = useMuseumStore((s) => s.player);
	const roomIndex = useMuseumStore((s) => s.roomIndex);
	const teleport = useMuseumStore((s) => s.teleport);

	if (!world || !entered) return null;

	return (
		<div className="pointer-events-none absolute top-6 right-6 z-30">
			<FloorPlan
				world={world}
				activeRoom={roomIndex}
				player={player}
				onPick={teleport}
				className="pointer-events-auto cursor-pointer rounded-lg border border-white/10 bg-black/45 backdrop-blur-sm"
			/>
		</div>
	);
}
