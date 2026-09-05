import { Button } from "@aqt-gallery/ui/components/button";
import { Input } from "@aqt-gallery/ui/components/input";
import { cn } from "@aqt-gallery/ui/lib/utils";
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { LIGHT_COLORS, type ThemeValue, withThemeDefaults } from "../museum/theme";

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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-medium text-muted-foreground">{children}</span>;
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
    <div className="mt-2 flex flex-col gap-4 border bg-card p-4 sm:flex-row">
      <div
        className="relative aspect-[3/4] w-full shrink-0 overflow-hidden ring-1 ring-foreground/10 sm:aspect-auto sm:w-32"
        style={{
          background: `linear-gradient(180deg, ${draft.wallColor} 0%, ${draft.accentWallColor} 55%, ${draft.floorColor} 55%)`,
        }}
      >
        <span
          className="absolute top-2 left-1/2 h-1.5 w-12 -translate-x-1/2 rounded-full opacity-95"
          style={{ background: LIGHT_COLORS[draft.lightTemperature] }}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <FieldLabel>Wall color</FieldLabel>
            <ColorRow
              label="Wall color"
              value={draft.wallColor}
              onChange={(v) => set("wallColor", v)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel>Accent wall</FieldLabel>
            <ColorRow
              label="Accent wall color"
              value={draft.accentWallColor}
              onChange={(v) => set("accentWallColor", v)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel>Floor color</FieldLabel>
            <ColorRow
              label="Floor color"
              value={draft.floorColor}
              onChange={(v) => set("floorColor", v)}
            />
          </div>

          <label className="flex flex-col gap-1.5">
            <FieldLabel>
              Floor finish —{" "}
              {draft.floorRoughness <= 0.33
                ? "polished"
                : draft.floorRoughness >= 0.7
                  ? "matte"
                  : "satin"}
            </FieldLabel>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={draft.floorRoughness}
              onChange={(e) => set("floorRoughness", e.target.valueAsNumber)}
              className="w-full accent-foreground"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>Ambient — {draft.ambientIntensity.toFixed(2)}×</FieldLabel>
            <input
              type="range"
              min={0}
              max={3}
              step={0.05}
              value={draft.ambientIntensity}
              onChange={(e) => set("ambientIntensity", e.target.valueAsNumber)}
              className="w-full accent-foreground"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>Light temperature</FieldLabel>
            <select
              value={draft.lightTemperature}
              onChange={(e) =>
                set(
                  "lightTemperature",
                  e.target.value as GalleryThemeValue["lightTemperature"] & string,
                )
              }
              className="h-8 w-full rounded-none border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              <option value="warm">Warm</option>
              <option value="neutral">Neutral</option>
              <option value="cool">Cool</option>
            </select>
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || isDefault}
            onClick={() => setDraft(withThemeDefaults(null))}
          >
            <RotateCcw />
            Reset to defaults
          </Button>
          <Button size="sm" disabled={disabled || !dirty} onClick={() => onSave(draft)}>
            Save theme
          </Button>
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
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${label} picker`}
        className="size-8 shrink-0 cursor-pointer rounded-none border border-input bg-transparent p-0.5"
      />
      <Input
        type="text"
        value={text}
        aria-label={`${label} hex`}
        spellCheck={false}
        className={cn("min-w-0 flex-1 font-mono uppercase")}
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
