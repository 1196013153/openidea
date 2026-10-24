/**
 * Project view state: lazily loaded listings, expansion / selection (keyed by
 * node key = path), view options, inline editing and the internal clipboard.
 * Kept outside React so actions (keyboard, Find Action, context menu) share it.
 */
import { create } from "zustand";
import type { FileEntry } from "@/bindings";
import { IpcError } from "@/platform/ipc";
import {
  DEFAULT_TREE_OPTIONS,
  buildModel,
  withExtraRoots,
  dropListings,
  isDirEntry,
  mergeListing,
  planRefresh,
  visibleEntries,
  type Placeholder,
  type TreeModel,
  type TreeOptions,
} from "./model";
import { projectFs } from "./fs";
import { projectViewRoots, useProjectViewRoots, type ProjectViewRootContribution } from "@/workbench/contributions";
import { ancestorsWithin, isSameOrInside, type PackageKind } from "./paths";

export interface ViewOptions extends TreeOptions {
  /** Select the active editor's file in the tree. */
  autoscrollFromSource: boolean;
  /** Open the selected file while navigating the tree (preview, no focus change). */
  autoscrollToSource: boolean;
  /** Single click opens files (as regular tabs). */
  singleClickOpen: boolean;
  /** Single click shows files in the preview tab (IDEA's "Enable Preview Tab"). */
  previewTab: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  ...DEFAULT_TREE_OPTIONS,
  autoscrollFromSource: false,
  autoscrollToSource: false,
  singleClickOpen: false,
  // IDEA's "Enable Preview Tab" is off by default.
  previewTab: false,
};

export type Editing =
  | { kind: "new"; parent: string; nodeKind: "file" | "dir"; pkg?: PackageKind }
  | { kind: "rename"; key: string; path: string };

export interface Clipboard {
  paths: string[];
  cut: boolean;
}

interface ProjectTreeState {
  root: string | null;
  name: string;
  listings: ReadonlyMap<string, readonly FileEntry[]>;
  expanded: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  lead: string | null;
  options: ViewOptions;
  editing: Editing | null;
  clipboard: Clipboard | null;
  /** A path to select (and scroll to) once its row is visible. */
  revealRequest: { path: string; focus: boolean; seq: number } | null;
  /** Folder key highlighted as drop target. */
  dropTarget: string | null;
}

const OPTIONS_KEY = "openidea.projectTree.options";
const expandedKey = (root: string) => `openidea.projectTree.expanded:${root}`;
const MAX_PERSISTED = 3000;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full: expansion just isn't remembered */
  }
}

export const useProjectTree = create<ProjectTreeState>(() => ({
  root: null,
  name: "",
  listings: new Map(),
  expanded: new Set(),
  selected: new Set(),
  lead: null,
  options: { ...DEFAULT_VIEW_OPTIONS, ...readJson<Partial<ViewOptions>>(OPTIONS_KEY) },
  editing: null,
  clipboard: null,
  revealRequest: null,
  dropTarget: null,
}));

const get = () => useProjectTree.getState();
const set = (patch: Partial<ProjectTreeState>) => useProjectTree.setState(patch);

// ---------------------------------------------------------------------------
// Derived model (memoised on its inputs so React and actions share one instance)

let memo: {
  root: string | null;
  name: string;
  listings: ProjectTreeState["listings"];
  options: ViewOptions;
  editing: Editing | null;
  extras: ReadonlyMap<string, ProjectViewRootContribution>;
  model: TreeModel;
} | null = null;

const EMPTY_MODEL: TreeModel = { roots: [], children: new Map(), byKey: new Map(), keyOfPath: new Map() };

export function selectModel(s: ProjectTreeState): TreeModel {
  if (
    memo &&
    memo.root === s.root &&
    memo.name === s.name &&
    memo.listings === s.listings &&
    memo.options === s.options &&
    memo.editing === s.editing &&
    memo.extras === useProjectViewRoots.getState().roots
  )
    return memo.model;
  const placeholder: Placeholder | null =
    s.editing?.kind === "new" ? { parent: s.editing.parent, kind: s.editing.nodeKind } : null;
  const extras = useProjectViewRoots.getState().roots;
  const model = s.root
    ? withExtraRoots(buildModel({ path: s.root, name: s.name }, s.listings, s.options, placeholder), projectViewRoots(extras), s.listings, s.options, placeholder)
    : EMPTY_MODEL;
  memo = { root: s.root, name: s.name, listings: s.listings, options: s.options, editing: s.editing, extras, model };
  return model;
}

export const currentModel = () => selectModel(get());

// ---------------------------------------------------------------------------
// Lifecycle

let generation = 0;
const inflight = new Map<string, Promise<void>>();
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** Resets the view for a newly opened project, restoring its expansion state. */
export function initProjectTree(root: string | null, name = "") {
  generation++;
  inflight.clear();
  clearTimeout(persistTimer);
  const persisted = root ? (readJson<string[]>(expandedKey(root)) ?? []) : [];
  const expanded = new Set(persisted.filter((p) => root && isSameOrInside(p, root)));
  if (root) expanded.add(root);
  set({
    root,
    name,
    listings: new Map(),
    expanded,
    selected: new Set(),
    lead: null,
    editing: null,
    clipboard: null,
    revealRequest: null,
    dropTarget: null,
  });
}

function persistExpanded() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const { root, expanded } = get();
    if (root) writeJson(expandedKey(root), [...expanded].slice(0, MAX_PERSISTED));
  }, 300);
}

export function setExpanded(expanded: ReadonlySet<string>) {
  set({ expanded });
  persistExpanded();
}

export function setSelection(selected: ReadonlySet<string>, lead: string | null) {
  set({ selected, lead });
}

export function setViewOption<K extends keyof ViewOptions>(key: K, value: ViewOptions[K]) {
  const options = { ...get().options, [key]: value };
  set({ options });
  writeJson(OPTIONS_KEY, options);
}

// ---------------------------------------------------------------------------
// Loading

function putListing(path: string, entries: readonly FileEntry[]) {
  const { listings } = get();
  const merged = mergeListing(listings.get(path), entries);
  if (merged === listings.get(path)) return;
  set({ listings: new Map(listings).set(path, merged) });
}

/** Loads (or reloads) one folder. Concurrent calls for the same folder share a request. */
export function loadDir(path: string, force = false): Promise<void> {
  const { root, listings } = get();
  if (!root) return Promise.resolve();
  if (!force && listings.has(path)) return Promise.resolve();
  const running = inflight.get(path);
  if (running) return running;
  const gen = generation;
  const p = (async () => {
    try {
      const entries = await projectFs(root).readDir(path);
      if (gen !== generation) return;
      putListing(path, entries);
      // Compact Middle Packages needs to look one level down a single-folder chain.
      const s = get();
      if (s.options.compact) {
        const visible = visibleEntries(entries, s.options);
        const only = visible.length === 1 ? visible[0]! : null;
        if (only && isDirEntry(only) && !only.ignored && !s.listings.has(only.path)) void loadDir(only.path);
      }
    } catch (e) {
      if (gen !== generation) return;
      const s = get();
      if (e instanceof IpcError && (e.kind === "notFound" || e.kind === "invalidInput")) {
        const listings = new Map(s.listings);
        dropListings(listings, [path]);
        const expanded = new Set([...s.expanded].filter((k) => !isSameOrInside(k, path) || k === s.root));
        set({ listings, expanded });
        if (path === s.root) set({ listings: new Map(listings).set(path, []) });
      } else {
        console.warn(`project view: cannot read ${path}`, e);
        putListing(path, s.listings.get(path) ?? []);
      }
    } finally {
      if (gen === generation) inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  return p;
}

export function isLoading(path: string): boolean {
  return inflight.has(path);
}

/** Applies a backend `fsChanged` event: reloads affected loaded folders only. */
export async function applyFsChange(event: { created: string[]; modified: string[]; removed: string[] }) {
  const s = get();
  if (!s.root) return;
  const plan = planRefresh(event, new Set(s.listings.keys()));
  if (plan.drop.length) {
    const listings = new Map(s.listings);
    dropListings(listings, plan.drop);
    const gone = (k: string) => plan.drop.some((d) => isSameOrInside(k, d));
    const selected = [...s.selected].filter((k) => !gone(k));
    set({
      listings,
      selected: selected.length === s.selected.size ? s.selected : new Set(selected),
      lead: s.lead && gone(s.lead) ? null : s.lead,
    });
  }
  // Removed files: drop them from the selection too.
  if (event.removed.length) {
    const cur = get();
    const removed = new Set(event.removed);
    if ([...cur.selected].some((k) => removed.has(k))) {
      set({
        selected: new Set([...cur.selected].filter((k) => !removed.has(k))),
        lead: cur.lead && removed.has(cur.lead) ? null : cur.lead,
      });
    }
  }
  await Promise.all(plan.reload.map((p) => loadDir(p, true)));
}

/** Re-reads every loaded folder (View › Reload from Disk). */
export async function reloadAll() {
  const { listings } = get();
  await Promise.all([...listings.keys()].map((p) => loadDir(p, true)));
}

// ---------------------------------------------------------------------------
// Reveal / expand

let revealSeq = 0;

/** Expands the ancestors of `path` and selects it once visible. */
export function revealPath(path: string, focus = false) {
  const { expanded } = get();
  const project = get().root;
  const root = project && isSameOrInside(path, project) ? project : project ? extraRootOf(path) : null;
  if (!root) return false;
  const ancestors = ancestorsWithin(root, path);
  const next = new Set(expanded);
  let changed = false;
  for (const a of ancestors)
    if (!next.has(a)) {
      next.add(a);
      changed = true;
    }
  if (changed) setExpanded(next);
  set({ revealRequest: { path, focus, seq: ++revealSeq } });
  for (const a of ancestors) void loadDir(a);
  return true;
}

/** The contributed root (scratches…) containing `path`, if any. */
export function extraRootOf(path: string): string | null {
  for (const r of useProjectViewRoots.getState().roots.values()) if (isSameOrInside(path, r.path)) return r.path;
  return null;
}

export function clearRevealRequest(seq: number) {
  if (get().revealRequest?.seq === seq) set({ revealRequest: null });
}

/** Expands every folder below `from` (skipping excluded ones), loading as needed; capped. */
export async function expandAll(from?: string, limit = 400) {
  const { root } = get();
  if (!root) return;
  const start = from ?? root;
  const queue = [start];
  const toExpand = new Set(get().expanded);
  let count = 0;
  const gen = generation;
  while (queue.length && count < limit) {
    const dir = queue.shift()!;
    toExpand.add(dir);
    count++;
    await loadDir(dir);
    if (gen !== generation) return;
    const s = get();
    for (const e of visibleEntries(s.listings.get(dir) ?? [], s.options))
      if (isDirEntry(e) && !e.ignored && e.kind !== "symlink") queue.push(e.path);
  }
  setExpanded(toExpand);
}

export function collapseAll() {
  const { root } = get();
  if (root) setExpanded(new Set([root]));
}

// ---------------------------------------------------------------------------
// Editing / clipboard / drag state

export function startEditing(editing: Editing | null) {
  set({ editing });
}

export function setClipboard(clipboard: Clipboard | null) {
  set({ clipboard });
}

export function setDropTarget(key: string | null) {
  if (get().dropTarget !== key) set({ dropTarget: key });
}
