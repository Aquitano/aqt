import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import {
	LIGHT_COLORS,
	type ThemeValue,
	withThemeDefaults,
} from "../museum/theme";

/** Re-exported under the editor's historical name; the shape now lives in
 * the shared theme module. */
export type GalleryThemeValue = ThemeValue;

function shallowEqual(a: Required<ThemeValue>, b: Required<ThemeValue>) {
	return (
		a.wallColor === b.wallColor &&
		a.accentWallColor === b.accentWallColor &&
		a.floorColor === b.floorColor &&
		a.floorRoughness === b.floorRoughness &&
		a.ambientIntensity === b.ambientIntensity &&
		a.lightTemperature === b.lightTemperature
	);
}

export function GalleryThemePanel({
	groupId,
	theme,
	disabled,
	onSave,
}: {
	groupId: string;
	theme: GalleryThemeValue | null | undefined;
	disabled: boolean;
	onSave: (theme: GalleryThemeValue) => void | Promise<void>;
}) {
	const [draft, setDraft] = useState(() => withThemeDefaults(theme));

	// Reload the form when switching to a different gallery (and after a save
	// reconciles, since the value then matches and the reset is a no-op).
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on gallery switch
	useEffect(() => {
		setDraft(withThemeDefaults(theme));
	}, [groupId]);

	const saved = withThemeDefaults(theme);
	const dirty = !shallowEqual(draft, saved);
	const isDefault = shallowEqual(draft, withThemeDefaults(null));

	const set = <K extends keyof Required<GalleryThemeValue>>(
		key: K,
		value: Required<GalleryThemeValue>[K],
	) => setDraft((d) => ({ ...d, [key]: value }));

	return (
		<div className="gallery-theme-panel">
			<div
				className="gallery-theme-preview"
				style={{
					background: `linear-gradient(180deg, ${draft.wallColor} 0%, ${draft.accentWallColor} 55%, ${draft.floorColor} 55%)`,
				}}
			>
				<span
					className="gallery-theme-preview-light"
					style={{ background: LIGHT_COLORS[draft.lightTemperature] }}
				/>
			</div>

			<div className="gallery-theme-body">
				<div className="gallery-theme-grid">
					<div className="gallery-field">
						<span>Wall color</span>
						<ColorRow
							label="Wall color"
							value={draft.wallColor}
							onChange={(v) => set("wallColor", v)}
						/>
					</div>
					<div className="gallery-field">
						<span>Accent wall</span>
						<ColorRow
							label="Accent wall color"
							value={draft.accentWallColor}
							onChange={(v) => set("accentWallColor", v)}
						/>
					</div>
					<div className="gallery-field">
						<span>Floor color</span>
						<ColorRow
							label="Floor color"
							value={draft.floorColor}
							onChange={(v) => set("floorColor", v)}
						/>
					</div>

					<label className="gallery-field">
						<span>
							Floor finish —{" "}
							{draft.floorRoughness <= 0.33
								? "polished"
								: draft.floorRoughness >= 0.7
									? "matte"
									: "satin"}
						</span>
						<input
							type="range"
							min={0}
							max={1}
							step={0.02}
							value={draft.floorRoughness}
							onChange={(e) => set("floorRoughness", e.target.valueAsNumber)}
						/>
					</label>
					<label className="gallery-field">
						<span>Ambient light — {draft.ambientIntensity.toFixed(2)}×</span>
						<input
							type="range"
							min={0}
							max={3}
							step={0.05}
							value={draft.ambientIntensity}
							onChange={(e) => set("ambientIntensity", e.target.valueAsNumber)}
						/>
					</label>
					<label className="gallery-field">
						<span>Light temperature</span>
						<select
							value={draft.lightTemperature}
							onChange={(e) =>
								set(
									"lightTemperature",
									e.target.value as GalleryThemeValue["lightTemperature"] &
										string,
								)
							}
						>
							<option value="warm">Warm</option>
							<option value="neutral">Neutral</option>
							<option value="cool">Cool</option>
						</select>
					</label>
				</div>

				<div className="gallery-theme-actions">
					<button
						type="button"
						className="gallery-secondary-button"
						disabled={disabled || isDefault}
						onClick={() => setDraft(withThemeDefaults(null))}
					>
						<RotateCcw size={14} />
						Reset to defaults
					</button>
					<button
						type="button"
						className="gallery-primary-button gallery-save-button"
						disabled={disabled || !dirty}
						onClick={() => onSave(draft)}
					>
						Save theme
					</button>
				</div>
			</div>
		</div>
	);
}

/** A native color picker paired with an editable hex field, kept in sync.
 * The text field holds its own draft so partial typing works; only a valid
 * 6-digit hex is committed upward. */
function ColorRow({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const [text, setText] = useState(value);

	// Follow external changes (color picker, reset, gallery switch).
	useEffect(() => setText(value), [value]);

	return (
		<div className="gallery-color-row">
			<input
				type="color"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				aria-label={`${label} picker`}
			/>
			<input
				type="text"
				className="gallery-color-hex"
				value={text}
				aria-label={`${label} hex`}
				spellCheck={false}
				onChange={(e) => {
					const v = e.target.value;
					setText(v);
					if (/^#[0-9a-fA-F]{6}$/.test(v)) {
						onChange(v);
					}
				}}
				onBlur={() => setText(value)}
			/>
		</div>
	);
}
