/**
 * Tool window layout state, IDEA semantics: at most one visible window per
 * anchor; showing another window on the same anchor replaces it. Layout
 * (visible windows + sizes) is persisted per project root in localStorage.
 */
import { create } from "zustand";
import { setContext } from "@/platform/context";
import {
  useContributions,
  type ToolWindowAnchor,
  type ToolWindowContribution,
  type ToolWindowService,
} from "../contributions";
import { focusEditor } from "../focus";

export const ANCHORS: readonly ToolWindowAnchor[] = ["left", "bottom", "right"];

export const DEFAULT_SIZES: Record<ToolWindowAnchor, number> = { left: 240, right: 300, bottom: 280 };
const DEFAULT_VISIBLE: Record<ToolWindowAnchor, string | null> = { left: "project", right: null, bottom: null };
const STORAGE_PREFIX = "openidea.layout.v1:";

/** User placement of a tool window (dragged to another stripe / "Move to"), overriding the contribution. */
export interface ToolWindowPlacement {
  anchor: ToolWindowAnchor;
  secondary?: boolean;
  order?: number;
}

/** Stripe groups: top / bottom part of the left and right stripes. */
export type StripeGroup = "left-top" | "left-bottom" | "right-top" | "right-bottom";

export interface ToolWindowLayoutState {
  scope: string;
  visible: Record<ToolWindowAnchor, string | null>;
  sizes: Record<ToolWindowAnchor, number>;
  maximized: ToolWindowAnchor | null;
  /** Tool window containing DOM focus. */
  focused: string | null;
  /** Most recently activated window (target of Shift+Escape). */
  lastActive: string | null;
  /** Windows shown at least once; kept mounted while hidden on their anchor. */
  mounted: ReadonlySet<string>;
  /** Bumped to ask a panel to take focus. */
  focusRequest: { id: string; seq: number } | null;
  /** Visible set stashed by "Hide All" so pressing it again restores. */
  stashed: Record<ToolWindowAnchor, string | null> | null;
  /** Per-window placement overrides (persisted). */
  placements: Readonly<Record<string, ToolWindowPlacement>>;
  /** User choice of stripe buttons (opened → added, "Hide" → removed); persisted. */
  stripeButtons: Readonly<Record<string, boolean>>;
  /** Layout before Distraction Free Mode; restored on exit and persisted in place of `visible` meanwhile. */
  distractionFreeStash: Record<ToolWindowAnchor, string | null> | null;
}

const initial = (): ToolWindowLayoutState => ({
  scope: "",
  visible: { ...DEFAULT_VISIBLE },
  sizes: { ...DEFAULT_SIZES },
  maximized: null,
  focused: null,
  lastActive: null,
  mounted: new Set(Object.values(DEFAULT_VISIBLE).filter((v): v is string => !!v)),
  focusRequest: null,
  stashed: null,
  placements: {},
  stripeButtons: {},
  distractionFreeStash: null,
});

export const useToolWindowLayout = create<ToolWindowLayoutState>(initial);

let focusSeq = 0;

export function anchorOf(id: string): ToolWindowAnchor | undefined {
  const tw = useContributions.getState().toolWindows.get(id);
  if (!tw) return undefined;
  return useToolWindowLayout.getState().placements[id]?.anchor ?? tw.anchor;
}

/** The contribution with the user's placement applied. */
export function placed(tw: ToolWindowContribution, placements: Readonly<Record<string, ToolWindowPlacement>>): ToolWindowContribution {
  const p = placements[tw.id];
  if (!p) return tw;
  return { ...tw, anchor: p.anchor, secondary: p.secondary ?? false, order: p.order ?? tw.order };
}

/** Which stripe group shows a (placed) window. Bottom windows sit in the left stripe's lower group (IDEA new UI). */
export function stripeGroupOf(tw: Pick<ToolWindowContribution, "anchor" | "secondary">): StripeGroup {
  if (tw.anchor === "bottom") return "left-bottom";
  // The left stripe's lower group is the bottom anchor; a left window there would light up alongside a bottom one.
  if (tw.anchor === "left") return "left-top";
  return `${tw.anchor}-${tw.secondary ? "bottom" : "top"}` as StripeGroup;
}

function groupPlacement(group: StripeGroup): Omit<ToolWindowPlacement, "order"> {
  switch (group) {
    case "left-top":
      return { anchor: "left" };
    case "left-bottom":
      return { anchor: "bottom" };
    case "right-top":
      return { anchor: "right" };
    case "right-bottom":
      return { anchor: "right", secondary: true };
  }
}

const byOrder = (a: ToolWindowContribution, b: ToolWindowContribution) =>
  (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title);

/**
 * Moves a tool window to a stripe group, before `before` (or last). Orders of
 * the target group are renumbered so the drop position sticks. A visible
 * window stays visible at its new anchor (replacing what was shown there).
 */
export function moveToolWindow(id: string, group: StripeGroup, before: string | null = null) {
  const contributions = useContributions.getState().toolWindows;
  const tw = contributions.get(id);
  if (!tw) return;
  const s = useToolWindowLayout.getState();
  const oldAnchor = anchorOf(id)!;
  const wasVisible = s.visible[oldAnchor] === id;
  const members = [...contributions.values()]
    .map((w) => placed(w, s.placements))
    .filter((w) => w.id !== id && stripeGroupOf(w) === group)
    .sort(byOrder);
  const at = before ? members.findIndex((w) => w.id === before) : -1;
  const ids = members.map((w) => w.id);
  ids.splice(at >= 0 ? at : ids.length, 0, id);
  const placements: Record<string, ToolWindowPlacement> = { ...s.placements };
  ids.forEach((wid, i) => {
    const current = placed(contributions.get(wid)!, s.placements);
    const target = wid === id ? groupPlacement(group) : { anchor: current.anchor, secondary: current.secondary };
    placements[wid] = { ...target, order: (i + 1) * 10 };
  });
  const newAnchor = placements[id]!.anchor;
  const visible = { ...s.visible };
  if (wasVisible && oldAnchor !== newAnchor) {
    visible[oldAnchor] = null;
    visible[newAnchor] = id;
  }
  update({
    placements,
    visible,
    maximized: wasVisible && s.maximized === oldAnchor ? null : s.maximized,
  });
}

/** Forgets every placement override and stripe button choice ("Restore Default Layout"). */
export function resetToolWindowPlacements() {
  const s = useToolWindowLayout.getState();
  const visible = { ...s.visible };
  // Windows shown at an anchor they no longer belong to are hidden.
  for (const a of ANCHORS) {
    const id = visible[a];
    if (id && useContributions.getState().toolWindows.get(id)?.anchor !== a) visible[a] = null;
  }
  update({ placements: {}, stripeButtons: {}, visible });
}

function storageKey(scope: string) {
  return STORAGE_PREFIX + scope;
}

function readStorage(
  scope: string,
): Partial<Pick<ToolWindowLayoutState, "visible" | "sizes" | "placements" | "stripeButtons">> | null {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persist() {
  const { scope, visible: current, sizes, placements, stripeButtons, distractionFreeStash } = useToolWindowLayout.getState();
  // Distraction Free Mode is not saved: the layout to restore is.
  const visible = distractionFreeStash ?? current;
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify({ visible, sizes, placements, stripeButtons }));
  } catch {
    /* storage unavailable */
  }
}

function sanitizeSizes(sizes: unknown): Record<ToolWindowAnchor, number> {
  const out = { ...DEFAULT_SIZES };
  if (sizes && typeof sizes === "object") {
    for (const a of ANCHORS) {
      const v = (sizes as Record<string, unknown>)[a];
      if (typeof v === "number" && isFinite(v) && v >= 80 && v <= 4000) out[a] = Math.round(v);
    }
  }
  return out;
}

export function sanitizePlacements(raw: unknown): Record<string, ToolWindowPlacement> {
  const out: Record<string, ToolWindowPlacement> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = v as Partial<ToolWindowPlacement> | null;
    if (!p || !ANCHORS.includes(p.anchor as ToolWindowAnchor)) continue;
    out[id] = {
      anchor: p.anchor as ToolWindowAnchor,
      ...(p.secondary ? { secondary: true } : {}),
      ...(typeof p.order === "number" && isFinite(p.order) ? { order: p.order } : {}),
    };
  }
  return out;
}

function sanitizeStripeButtons(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (raw && typeof raw === "object")
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "boolean") out[id] = v;
  return out;
}

/** Loads the layout saved for `scope` (a project root; "" without a project). */
export function loadToolWindowLayout(scope: string) {
  const saved = readStorage(scope);
  const visible = { ...DEFAULT_VISIBLE };
  if (saved?.visible && typeof saved.visible === "object") {
    for (const a of ANCHORS) {
      const v = (saved.visible as Record<string, unknown>)[a];
      visible[a] = typeof v === "string" ? v : null;
    }
  }
  useToolWindowLayout.setState({
    ...initial(),
    scope,
    visible,
    sizes: sanitizeSizes(saved?.sizes),
    placements: sanitizePlacements(saved?.placements),
    stripeButtons: sanitizeStripeButtons(saved?.stripeButtons),
    mounted: new Set(Object.values(visible).filter((v): v is string => !!v)),
  });
  publishVisibility();
}

function publishVisibility() {
  const { visible } = useToolWindowLayout.getState();
  for (const id of useContributions.getState().toolWindows.keys()) {
    const a = anchorOf(id);
    setContext(`toolWindow.${id}.visible`, !!a && visible[a] === id);
  }
}

function update(patch: Partial<ToolWindowLayoutState>, save = true) {
  useToolWindowLayout.setState(patch);
  publishVisibility();
  if (save) persist();
}

export function isToolWindowVisible(id: string): boolean {
  const a = anchorOf(id);
  return !!a && useToolWindowLayout.getState().visible[a] === id;
}

/** Last shown or focused tool window, kept after it is hidden (Jump to Last Tool Window). */
let lastUsed: string | null = null;

export function lastUsedToolWindow(): string | null {
  return lastUsed && anchorOf(lastUsed) ? lastUsed : null;
}

/** F12: focus the last used tool window, reopening it if it was hidden. */
export function jumpToLastToolWindow() {
  const id = lastUsedToolWindow() ?? (anchorOf("project") ? "project" : null);
  if (id) focusToolWindow(id);
}

export function showToolWindow(id: string, focus = false) {
  const a = anchorOf(id);
  if (!a) return;
  lastUsed = id;
  const s = useToolWindowLayout.getState();
  const mounted = s.mounted.has(id) ? s.mounted : new Set(s.mounted).add(id);
  update({
    visible: { ...s.visible, [a]: id },
    // Opening a window puts its button on the stripe (IDEA).
    stripeButtons: s.stripeButtons[id] ? s.stripeButtons : { ...s.stripeButtons, [id]: true },
    mounted,
    lastActive: id,
    stashed: null,
    maximized: s.maximized && s.maximized !== a ? null : s.maximized,
    focusRequest: focus ? { id, seq: ++focusSeq } : s.focusRequest,
  });
}

export function hideToolWindow(id: string) {
  const a = anchorOf(id);
  const s = useToolWindowLayout.getState();
  if (!a || s.visible[a] !== id) return;
  const hadFocus = s.focused === id || isFocusWithinToolWindow(id);
  update({
    visible: { ...s.visible, [a]: null },
    maximized: s.maximized === a ? null : s.maximized,
    lastActive: s.lastActive === id ? null : s.lastActive,
  });
  if (hadFocus) focusEditor();
}

/** Whether `tw` has a stripe button: the user's choice, else its default. */
export function hasStripeButton(tw: ToolWindowContribution, stripeButtons: Readonly<Record<string, boolean>>): boolean {
  return stripeButtons[tw.id] ?? tw.stripe !== "onUse";
}

/** Stripe button context menu "Hide": closes the window and removes its button (back under "…"). */
export function removeFromStripe(id: string) {
  hideToolWindow(id);
  const s = useToolWindowLayout.getState();
  update({ stripeButtons: { ...s.stripeButtons, [id]: false } });
}

export function toggleToolWindow(id: string) {
  if (isToolWindowVisible(id)) hideToolWindow(id);
  else showToolWindow(id, true);
}

/**
 * The `toolwindow.<id>` action: hidden → show + focus; visible but unfocused
 * → focus; visible and focused → hide (IDEA behaviour).
 */
export function activateToolWindow(id: string) {
  if (!isToolWindowVisible(id)) showToolWindow(id, true);
  else if (useToolWindowLayout.getState().focused !== id && !isFocusWithinToolWindow(id)) focusToolWindow(id);
  else hideToolWindow(id);
}

export function focusToolWindow(id: string) {
  if (!isToolWindowVisible(id)) return showToolWindow(id, true);
  update({ focusRequest: { id, seq: ++focusSeq }, lastActive: id }, false);
}

/** Hides every visible window; called again with nothing visible, restores them. */
export function hideAllToolWindows() {
  const s = useToolWindowLayout.getState();
  const anyVisible = ANCHORS.some((a) => s.visible[a]);
  if (anyVisible) {
    const hadFocus = !!s.focused;
    update({ stashed: { ...s.visible }, visible: { left: null, right: null, bottom: null }, maximized: null });
    if (hadFocus) focusEditor();
  } else if (s.stashed) {
    update({ visible: { ...s.stashed }, stashed: null });
  }
}

/**
 * Entering Distraction Free Mode: remembers the visible windows and hides
 * them. Windows can still be opened meanwhile (by shortcut); exiting
 * restores the remembered layout. No-op without a project layout loaded.
 */
export function enterDistractionFreeLayout() {
  const s = useToolWindowLayout.getState();
  if (!s.scope || s.distractionFreeStash) return;
  const hadFocus = !!s.focused;
  update({
    distractionFreeStash: { ...s.visible },
    visible: { left: null, right: null, bottom: null },
    maximized: null,
    stashed: null,
  });
  if (hadFocus) focusEditor();
}

export function exitDistractionFreeLayout() {
  const s = useToolWindowLayout.getState();
  if (!s.distractionFreeStash) return;
  const visible = { ...s.distractionFreeStash };
  const mounted = new Set(s.mounted);
  for (const id of Object.values(visible)) if (id) mounted.add(id);
  update({ visible, mounted, distractionFreeStash: null, maximized: null, stashed: null });
  if (s.focused && !Object.values(visible).includes(s.focused)) focusEditor();
}

export function hideActiveToolWindow() {
  const s = useToolWindowLayout.getState();
  const id = s.focused ?? s.lastActive;
  if (id) hideToolWindow(id);
}

export function setToolWindowSize(anchor: ToolWindowAnchor, px: number) {
  const s = useToolWindowLayout.getState();
  const v = Math.round(px);
  if (s.maximized === anchor || v < 80 || s.sizes[anchor] === v) return;
  update({ sizes: { ...s.sizes, [anchor]: v } });
}

export function toggleMaximizeToolWindow(id: string) {
  const a = anchorOf(id);
  if (!a) return;
  if (!isToolWindowVisible(id)) showToolWindow(id, true);
  const s = useToolWindowLayout.getState();
  update({ maximized: s.maximized === a ? null : a }, false);
}

export function setFocusedToolWindow(id: string | null) {
  const s = useToolWindowLayout.getState();
  if (s.focused === id) return;
  if (id) lastUsed = id;
  useToolWindowLayout.setState({ focused: id, lastActive: id ?? s.lastActive });
  setContext("toolWindowFocus", !!id);
  setContext("activeToolWindow", id ?? "");
}

function isFocusWithinToolWindow(id: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement?.closest?.("[data-toolwindow]");
  return el?.getAttribute("data-toolwindow") === id;
}

export const toolWindowServiceImpl: ToolWindowService = {
  show: (id, focus) => showToolWindow(id, focus),
  hide: hideToolWindow,
  toggle: toggleToolWindow,
  isVisible: isToolWindowVisible,
};

/** Test helper. */
export function resetToolWindowLayout() {
  lastUsed = null;
  useToolWindowLayout.setState(initial());
}
