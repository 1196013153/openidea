/**
 * Keymaps and keyboard dispatch.
 *
 * Binding syntax: modifiers `Meta Ctrl Alt Shift` joined with `+` to a key, e.g.
 * `Meta+Shift+O`, `Alt+F7`, `F8`. Space separates chord strokes
 * (`Meta+K Meta+C`). The special binding `Shift Shift` is IDEA's double-Shift.
 * Keys are matched by physical position (`KeyboardEvent.code`), so ⌥-letter
 * combos work on macOS where `event.key` would be a symbol.
 */
import { create } from "zustand";
import { getAction, isActionKeyEnabled, executeAction } from "./actions";
import { getContext } from "./context";
import { intellijMacos } from "./keymaps/intellij-macos";
import { intellijWindows } from "./keymaps/intellij-windows";
import { vscodeMacos } from "./keymaps/vscode-macos";
import { vscodeWindows } from "./keymaps/vscode-windows";
import { usePlatform } from "./platformInfo";

export type Keymap = Record<string, string[]>;

/** macOS spells the primary modifier ⌘ (`Meta`); Windows and Linux use Ctrl. */
export const isMacHost = () => usePlatform.getState().os === "macos";

/** The preset used when settings name none (or an unknown one): IDEA's keymap for this OS. */
export function defaultPreset(): string {
  return isMacHost() ? "intellij-macos" : "intellij-windows";
}

export const PRESETS: Record<string, Keymap> = {
  "intellij-macos": intellijMacos,
  "intellij-windows": intellijWindows,
  "vscode-macos": vscodeMacos,
  "vscode-windows": vscodeWindows,
};

/** Display names of the presets, in menu order. */
export const PRESET_TITLES: Record<string, string> = {
  "intellij-macos": "macOS",
  "intellij-windows": "Windows",
  "vscode-macos": "VS Code (macOS)",
  "vscode-windows": "VS Code (Windows)",
};

/** ⌘ held on macOS, Ctrl elsewhere: the modifier of ⌘/Ctrl-click and copy/paste. */
export function hasPrimaryModifier(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">): boolean {
  return isMacHost() ? e.metaKey : e.ctrlKey;
}

/** A binding written for macOS (`Meta+C`) as this OS spells it (`Ctrl+C` on Windows/Linux). */
export function hostBinding(binding: string): string {
  return isMacHost() ? binding : binding.replace(/Meta\+/g, "Ctrl+");
}

/** `strokeOf` output in macOS spelling, so tables keyed `Meta+C` also match Ctrl+C on Windows/Linux. */
export function macStroke(stroke: string): string {
  return isMacHost() ? stroke : normalizeBinding(stroke.replace(/Ctrl\+/g, "Meta+"));
}

interface KeymapState {
  preset: string;
  /** User overrides: action id → bindings (empty array removes defaults). */
  overrides: Keymap;
}

export const useKeymap = create<KeymapState>(() => ({ preset: defaultPreset(), overrides: {} }));

const STROKE_RE = /^(?:(?:Ctrl|Alt|Shift|Meta)\+)*[^\s+]+$|^(?:(?:Ctrl|Alt|Shift|Meta)\+)*\+$/i;

/** Syntactic check: one or two strokes of `Mod+…+Key`, or `Shift Shift`. */
export function isValidBinding(binding: unknown): binding is string {
  if (typeof binding !== "string") return false;
  const b = binding.trim();
  if (b === "Shift Shift") return true;
  const strokes = b.split(/\s+/);
  return strokes.length >= 1 && strokes.length <= 2 && strokes.every((s) => STROKE_RE.test(s));
}

/**
 * Applies keymap settings (preset id + per-action overrides) to `useKeymap`.
 * Input comes from settings files, so it is validated: an unknown preset falls
 * back to the default, malformed bindings are dropped.
 */
export function applyKeymapSettings(preset: unknown, overrides: unknown, customKeymaps?: unknown): void {
  // A user keymap (`customKeymaps[id]`) is its parent preset plus its own overrides.
  const custom =
    typeof preset === "string" && customKeymaps && typeof customKeymaps === "object"
      ? ((customKeymaps as Record<string, unknown>)[preset] as { parent?: unknown; overrides?: unknown } | undefined)
      : undefined;
  if (custom && typeof custom === "object" && !PRESETS[preset as string]) {
    preset = custom.parent;
    overrides = custom.overrides;
  }
  const id = typeof preset === "string" && PRESETS[preset] ? preset : defaultPreset();
  const clean: Keymap = {};
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [action, keys] of Object.entries(overrides as Record<string, unknown>)) {
      if (!Array.isArray(keys)) continue;
      clean[action] = [...new Set(keys.filter(isValidBinding).map(normalizeBinding))];
    }
  }
  const prev = useKeymap.getState();
  if (prev.preset === id && JSON.stringify(prev.overrides) === JSON.stringify(clean)) return;
  useKeymap.setState({ preset: id, overrides: clean });
}

let suspended = 0;

/**
 * Pauses the global keyboard dispatcher (e.g. while recording a shortcut).
 * Returns a function that resumes it; calls nest.
 */
export function suspendKeyboardDispatch(): () => void {
  suspended++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    suspended--;
  };
}

export function bindingsFor(actionId: string): string[] {
  const { preset, overrides } = useKeymap.getState();
  return overrides[actionId] ?? PRESETS[preset]?.[actionId] ?? [];
}

/** Every (binding, actionId) pair of the effective keymap. */
export function effectiveBindings(): Array<[string, string]> {
  const { preset, overrides } = useKeymap.getState();
  const merged: Keymap = { ...PRESETS[preset], ...overrides };
  return Object.entries(merged).flatMap(([id, keys]) => keys.map((k) => [normalizeBinding(k), id] as [string, string]));
}

const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

/** Canonical form: modifiers in fixed order, so `Shift+Meta+o` == `Meta+Shift+O`. */
export function normalizeBinding(binding: string): string {
  return binding
    .trim()
    .split(/\s+/)
    .map((stroke) => {
      if (stroke === "Shift" || stroke === "Shift Shift") return stroke;
      const parts = stroke.split("+");
      const key = parts.pop()!;
      const mods = MOD_ORDER.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()));
      return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
    })
    .join(" ");
}

const CODE_NAMES: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadMultiply: "*",
  NumpadDivide: "/",
};

/** Converts a keydown event into a canonical stroke, or null for bare modifiers. */
export function strokeOf(
  e: Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = CODE_NAMES[e.code];
  if (!key) {
    if (["Shift", "Meta", "Control", "Alt"].includes(e.key)) return null;
    key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
  return [...mods, key].join("+");
}

const SYMBOLS: Record<string, string> = {
  Meta: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Enter: "↵",
  Escape: "⎋",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Space: "Space",
  PageUp: "⇞",
  PageDown: "⇟",
};

/**
 * Human display. macOS: `Meta+Shift+O` → `⇧⌘O`, `Shift Shift` → `⇧⇧`.
 * Windows/Linux: `Ctrl+Shift+N`, chords as `Ctrl+K, Ctrl+I`, `Shift, Shift`.
 */
export function formatBinding(binding: string, mac = isMacHost()): string {
  if (!mac) return binding === "Shift Shift" ? "Shift, Shift" : normalizeBinding(binding).split(" ").join(", ");
  if (binding === "Shift Shift") return "⇧⇧";
  return normalizeBinding(binding)
    .split(" ")
    .map((stroke) => {
      const parts = stroke.split("+");
      const key = parts.pop()!;
      // macOS menu order: ⌃⌥⇧⌘
      return parts.map((p) => SYMBOLS[p] ?? p).join("") + (SYMBOLS[key] ?? key);
    })
    .join(" ");
}

export function shortcutLabel(actionId: string): string | undefined {
  const b = bindingsFor(actionId)[0];
  return b ? formatBinding(b) : undefined;
}

// ---------------------------------------------------------------------------
// Dispatcher

/** How long IDEA waits for the second stroke of a chord. */
const CHORD_TIMEOUT = 2000;
/** IDEA's double-modifier timing: each press/release step. */
const DOUBLE_TAP_STEP_MS = 300;
/** A Shift tap this soon after typing another key is part of typing, not a gesture. */
const DOUBLE_TAP_TYPING_GUARD_MS = 100;

function isPlainTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.closest?.(".cm-editor")) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return !!el.closest?.(".cm-editor") || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/**
 * AltGr (reported as Ctrl+Alt on Windows) typing a character into a text field
 * or editor, e.g. `}` on a German or `ł` on a Polish layout: the character wins
 * over a Ctrl+Alt shortcut on the same key, as in IDEA.
 */
export function isAltGrTyping(
  e: Pick<KeyboardEvent, "key" | "code" | "target" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
    getModifierState?: (key: string) => boolean;
  },
): boolean {
  if (isMacHost() || !e.getModifierState?.("AltGraph")) return false;
  if (e.key !== "Dead" && e.key.length !== 1) return false;
  if (!isTextTarget(e.target)) return false;
  // Ctrl+Alt+L on a layout with no AltGr character there still reports `l`: that is a shortcut.
  const key = strokeOf(e)?.split("+").pop();
  return e.key === "Dead" || e.key.toUpperCase() !== key;
}

function runIfEnabled(id: string): boolean {
  const action = getAction(id);
  if (!action || !isActionKeyEnabled(action)) return false;
  void executeAction(id);
  return true;
}

/**
 * Installs the global keydown dispatcher (capture phase, so IDE shortcuts win
 * over CodeMirror defaults). Returns an uninstall function. `now` is the clock
 * for the double-Shift gesture.
 */
export function installKeyboardDispatcher(target: Window = window, now: () => number = () => performance.now()): () => void {
  let pending: string[] = [];
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  // Double Shift: 0 idle, 1 pressed, 2 released, 3 pressed again; fires on the second release.
  let shiftStep = 0;
  let shiftAt = 0;
  let otherKeyAt = -Infinity;

  const reset = () => {
    pending = [];
    clearTimeout(pendingTimer);
  };
  const resetShift = () => {
    shiftStep = 0;
  };

  const onShiftDown = (e: KeyboardEvent) => {
    const t = now();
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || t - otherKeyAt < DOUBLE_TAP_TYPING_GUARD_MS) return resetShift();
    if (shiftStep !== 0 && t - shiftAt > DOUBLE_TAP_STEP_MS) resetShift();
    if (shiftStep === 0 || shiftStep === 2) {
      shiftStep++;
      shiftAt = t;
    } else {
      resetShift();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (suspended > 0) {
      reset();
      resetShift();
      return;
    }
    if (e.key === "Shift") return onShiftDown(e);
    resetShift();
    otherKeyAt = e.key === "Escape" || e.key === "Tab" ? -Infinity : now();
    if (e.isComposing) return;
    const stroke = strokeOf(e);
    if (!stroke) return;
    const chord = pending.length > 0;
    if (!chord) {
      if (isAltGrTyping(e)) return;
      const hasCommandMod = e.metaKey || e.ctrlKey || e.altKey;
      if (!hasCommandMod && isPlainTextField(e.target) && !/^(Shift\+)?(F\d{1,2}|Escape)$/.test(stroke)) return;
    }

    const seq = [...pending, stroke].join(" ");
    const bindings = effectiveBindings();
    const ctx = getContext();
    const exact = bindings.filter(([b]) => b === seq).map(([, id]) => id);
    // Later presets/overrides win; the first enabled match runs.
    for (const id of exact.reverse()) {
      const action = getAction(id);
      if (action && isActionKeyEnabled(action, ctx)) {
        e.preventDefault();
        e.stopPropagation();
        reset();
        void executeAction(id);
        return;
      }
    }
    if (bindings.some(([b]) => b.startsWith(seq + " "))) {
      e.preventDefault();
      e.stopPropagation();
      pending.push(stroke);
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(reset, CHORD_TIMEOUT);
      return;
    }
    // A second stroke that completes no chord is swallowed, as in IDEA, not typed.
    if (chord) {
      e.preventDefault();
      e.stopPropagation();
    }
    reset();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (suspended > 0 || e.key !== "Shift" || shiftStep === 0) return;
    const t = now();
    if (e.metaKey || e.ctrlKey || e.altKey || t - shiftAt > DOUBLE_TAP_STEP_MS) return resetShift();
    if (shiftStep === 1) {
      shiftStep = 2;
      shiftAt = t;
      return;
    }
    const fire = shiftStep === 3;
    resetShift();
    if (!fire) return;
    const ids = effectiveBindings().filter(([b]) => b === "Shift Shift").map(([, id]) => id);
    for (const id of ids.reverse()) if (runIfEnabled(id)) return;
  };

  // Shift+click (extend a selection) is not half of a double Shift.
  const onMouseDown = () => resetShift();

  const onBlur = () => {
    reset();
    resetShift();
  };

  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("keyup", onKeyUp, true);
  target.addEventListener("mousedown", onMouseDown, true);
  target.addEventListener("blur", onBlur);
  return () => {
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("keyup", onKeyUp, true);
    target.removeEventListener("mousedown", onMouseDown, true);
    target.removeEventListener("blur", onBlur);
  };
}
