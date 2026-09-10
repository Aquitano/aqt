import { useEffect, useRef } from "react";

/**
 * One keyboard binding. `combo` is a `+`-separated chord where `mod` is ⌘ on
 * macOS and Ctrl elsewhere — e.g. `"i"`, `"mod+enter"`, `"escape"`.
 */
export type Hotkey = {
  combo: string;
  handler: (event: KeyboardEvent) => void;
  /** Fire even while a text field / contenteditable is focused. Default false. */
  enableOnFormTags?: boolean;
  /** Call `preventDefault()` when matched. Default true. */
  preventDefault?: boolean;
  /** Set false to ignore this binding without unmounting. Default true. */
  enabled?: boolean;
};

type ParsedCombo = {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
};

function parseCombo(combo: string): ParsedCombo {
  let mod = false;
  let shift = false;
  let alt = false;
  let key = "";
  for (const raw of combo.toLowerCase().split("+")) {
    const part = raw.trim();
    if (
      part === "mod" ||
      part === "cmd" ||
      part === "meta" ||
      part === "ctrl" ||
      part === "control"
    ) {
      mod = true;
    } else if (part === "shift") {
      shift = true;
    } else if (part === "alt" || part === "option") {
      alt = true;
    } else if (part) {
      key = part;
    }
  }
  return { key, mod, shift, alt };
}

function eventKey(event: KeyboardEvent): string {
  const key = event.key;
  if (key === " ") return "space";
  return key.toLowerCase();
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** True while a modal dialog is mounted — used to suppress plain-key shortcuts
 * so they can't reach (or steal focus out of) an open dialog. */
function isModalOpen(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.querySelector('[role="dialog"],[role="alertdialog"],[data-slot="dialog-content"]') !==
    null
  );
}

/** `true` on macOS/iOS, where the shortcut modifier renders as ⌘ rather than Ctrl. */
export function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "")
  );
}

/**
 * Registers global `keydown` shortcuts. Plain (un-modified) keys are ignored
 * while a form field is focused unless `enableOnFormTags` is set; `mod`-chords
 * and Escape always fire. Bindings are read from a ref each event, so handlers
 * stay fresh without re-attaching the listener.
 */
export function useHotkeys(hotkeys: Hotkey[]): void {
  const ref = useRef(hotkeys);
  ref.current = hotkeys;

  useEffect(() => {
    const isMac = isMacPlatform();

    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.repeat) return;

      const key = eventKey(event);
      const mod = isMac ? event.metaKey : event.ctrlKey;
      const editable = isEditableTarget(event.target);
      const modalOpen = isModalOpen();

      for (const hotkey of ref.current) {
        if (hotkey.enabled === false) continue;
        const parsed = parseCombo(hotkey.combo);
        if (parsed.key !== key) continue;
        if (parsed.mod !== mod) continue;
        if (parsed.alt !== event.altKey) continue;
        if (parsed.shift !== event.shiftKey) continue;
        // Plain (un-modified) shortcuts stay out of text fields and never
        // reach past an open modal; Escape and `mod`-chords always fire.
        const isPlain = !parsed.mod && key !== "escape";
        if (isPlain && ((editable && !hotkey.enableOnFormTags) || modalOpen)) {
          continue;
        }
        if (hotkey.preventDefault !== false) event.preventDefault();
        hotkey.handler(event);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
