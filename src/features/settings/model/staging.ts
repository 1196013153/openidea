/**
 * Settings dialog state. Edits are staged per (scope, key) and only written on
 * Apply / OK as one `settingsSet(scope, key, json)` call per changed key, like
 * IDEA's Configurable `isModified` / `apply` / `reset` cycle.
 */
import { create } from "zustand";
import { call, commands, isTauri, type Settings } from "@/platform/ipc";
import { loadSettings, useProject } from "@/platform/project";
import { deepEqual, getAt, setAt, validateSettings, type ValidSettings } from "./schema";

export type Scope = "global" | "project";

export interface StagedChange {
  scope: Scope;
  key: string;
  value: unknown;
  /** Page that made the change (Reset discards per page). */
  page: string;
}

export interface SettingsDialogState {
  open: boolean;
  pageId: string;
  query: string;
  /** Effective settings when the dialog opened / last applied. */
  base: ValidSettings;
  staged: Record<string, StagedChange>;
  /** Scope chosen per page (Global / This project). */
  scopes: Record<string, Scope>;
  saving: boolean;
  error: string | null;
}

export const DEFAULT_PAGE = "appearance";

export const useSettingsDialog = create<SettingsDialogState>(() => ({
  open: false,
  pageId: DEFAULT_PAGE,
  query: "",
  base: validateSettings(undefined),
  staged: {},
  scopes: {},
  saving: false,
  error: null,
}));

const stageKey = (scope: Scope, key: string) => `${scope}|${key}`;

export function openSettings(pageId?: string) {
  const s = useSettingsDialog.getState();
  useSettingsDialog.setState({
    open: true,
    pageId: pageId ?? s.pageId,
    query: "",
    base: validateSettings(useProject.getState().settings),
    staged: {},
    saving: false,
    error: null,
  });
}

export function closeSettings() {
  useSettingsDialog.setState({ open: false, staged: {}, error: null, saving: false });
}

export function selectPage(pageId: string) {
  useSettingsDialog.setState({ pageId });
}

export function setQuery(query: string) {
  useSettingsDialog.setState({ query });
}

export function setPageScope(pageId: string, scope: Scope) {
  useSettingsDialog.setState((s) => ({ scopes: { ...s.scopes, [pageId]: scope } }));
}

/** Current value of `key` as the page shows it: staged edit, else the effective value. */
export function stagedValue(s: Pick<SettingsDialogState, "base" | "staged">, scope: Scope, key: string): unknown {
  const hit = s.staged[stageKey(scope, key)];
  return hit ? hit.value : getAt(s.base, key);
}

export function stage(page: string, scope: Scope, key: string, value: unknown) {
  useSettingsDialog.setState((s) => {
    const staged = { ...s.staged };
    const id = stageKey(scope, key);
    // Back to the effective value: nothing to write.
    if (deepEqual(value, getAt(s.base, key))) delete staged[id];
    else staged[id] = { scope, key, value, page };
    return { staged, error: null };
  });
}

/** Discards staged edits of one page (the dialog's Reset button). */
export function resetPage(page: string) {
  useSettingsDialog.setState((s) => ({
    staged: Object.fromEntries(Object.entries(s.staged).filter(([, c]) => c.page !== page)),
    error: null,
  }));
}

/** Writes to perform, global layer first so a project value still wins afterwards. */
export function pendingChanges(s: Pick<SettingsDialogState, "base" | "staged">): StagedChange[] {
  return Object.values(s.staged)
    .filter((c) => !deepEqual(c.value, getAt(s.base, c.key)))
    .sort((a, b) => (a.scope === b.scope ? a.key.localeCompare(b.key) : a.scope === "global" ? -1 : 1));
}

export interface PersistDeps {
  set(scope: Scope, key: string, json: string): Promise<Settings>;
  /** Re-reads effective settings into `useProject`. */
  reload(): Promise<void>;
  /** Without a backend (plain browser) changes apply to the session only. */
  backend: boolean;
}

const defaultDeps = (): PersistDeps => ({
  set: (scope, key, json) => call(commands.settingsSet(scope, key, json)),
  reload: loadSettings,
  backend: isTauri(),
});

export interface PersistResult {
  /** Stage ids (`scope|key`) that were written. */
  written: string[];
  error: string | null;
}

/** Persists `changes` in order, stopping at the first failure (earlier writes stay, as in IDEA). */
export async function persistChanges(
  changes: StagedChange[],
  deps: PersistDeps = defaultDeps(),
): Promise<PersistResult> {
  const written: string[] = [];
  if (!deps.backend) {
    let settings = (useProject.getState().settings ?? {}) as Settings;
    for (const c of changes) {
      settings = setAt(settings, c.key, c.value);
      written.push(stageKey(c.scope, c.key));
    }
    useProject.setState({ settings });
    return { written, error: null };
  }
  let error: string | null = null;
  for (const c of changes) {
    try {
      const settings = await deps.set(c.scope, c.key, JSON.stringify(c.value));
      useProject.setState({ settings });
      written.push(stageKey(c.scope, c.key));
    } catch (e) {
      error = `${c.key}: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
  }
  if (written.length) await deps.reload().catch(() => {});
  return { written, error };
}

/** Apply: writes pending changes; returns whether everything was saved. */
export async function applySettings(deps?: PersistDeps): Promise<boolean> {
  const changes = pendingChanges(useSettingsDialog.getState());
  if (!changes.length) return true;
  useSettingsDialog.setState({ saving: true, error: null });
  const { written, error } = await persistChanges(changes, deps);
  const done = new Set(written);
  useSettingsDialog.setState((st) => ({
    saving: false,
    error,
    base: validateSettings(useProject.getState().settings),
    staged: Object.fromEntries(Object.entries(st.staged).filter(([k]) => !done.has(k))),
  }));
  return error === null;
}
