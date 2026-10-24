import { create } from "zustand";
import { getContext, type ContextKeys } from "@/platform/context";
import { loadJson, saveJson } from "../common/open";
import type { ProjectFileSet } from "@/platform/ipc";
import type { SeTab } from "./model";

interface SeState {
  open: boolean;
  tab: SeTab;
  query: string;
  includeNonProject: boolean;
  /** Scope of the Classes / Files / Symbols / Text tabs when not "All Places". */
  fileSet: ProjectFileSet;
  /** Context keys captured when the dialog opened (action enablement is judged against the editor, not the popup). */
  ctx: ContextKeys;
  /** Bumped on every (re)open so the field re-selects its text. */
  session: number;
  /** Code preview of the selected result under the list (remembered). */
  preview: boolean;
}

const PREVIEW_KEY = "openidea.search.everywherePreview.v1";

export const useSearchEverywhere = create<SeState>(() => ({
  open: false,
  tab: "all",
  query: "",
  includeNonProject: false,
  fileSet: "all",
  ctx: {},
  session: 0,
  preview: loadJson<unknown>(PREVIEW_KEY, false) === true,
}));

export function setSearchEverywherePreview(preview: boolean) {
  useSearchEverywhere.setState({ preview });
  saveJson(PREVIEW_KEY, preview);
}

/** Opens (or re-targets) the dialog. Re-invoking the same scope toggles "include non-project items", like IDEA. */
export function showSearchEverywhere(tab: SeTab, opts: { query?: string; toggleOnRepeat?: boolean } = {}) {
  const s = useSearchEverywhere.getState();
  if (s.open) {
    if (s.tab === tab || (opts.toggleOnRepeat && tab === "all")) {
      useSearchEverywhere.setState({ includeNonProject: !s.includeNonProject });
    } else {
      useSearchEverywhere.setState({ tab });
    }
    if (opts.query !== undefined) useSearchEverywhere.setState({ query: opts.query });
    return;
  }
  useSearchEverywhere.setState({
    open: true,
    tab,
    query: opts.query ?? s.query,
    includeNonProject: false,
    ctx: { ...getContext(), popupOpen: false },
    session: s.session + 1,
  });
}

export function hideSearchEverywhere() {
  useSearchEverywhere.setState({ open: false });
}

const RECENT_ACTIONS_KEY = "openidea.search.recentActions.v1";
const MAX_RECENT_ACTIONS = 12;

export function recentActions(): string[] {
  const v = loadJson<unknown>(RECENT_ACTIONS_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function pushRecentAction(id: string) {
  saveJson(RECENT_ACTIONS_KEY, [id, ...recentActions().filter((x) => x !== id)].slice(0, MAX_RECENT_ACTIONS));
}

const HISTORY_KEY = "openidea.search.everywhereHistory.v1";
const MAX_HISTORY = 50;

interface HistoryEntry {
  tab: SeTab;
  query: string;
}

function loadHistory(): HistoryEntry[] {
  const v = loadJson<unknown>(HISTORY_KEY, []);
  return Array.isArray(v)
    ? v.filter((x): x is HistoryEntry => typeof x?.tab === "string" && typeof x?.query === "string")
    : [];
}

/** Queries that led somewhere in `tab`, newest first. */
export function searchHistory(tab: SeTab): string[] {
  return loadHistory()
    .filter((e) => e.tab === tab)
    .map((e) => e.query);
}

export function pushSearchHistory(tab: SeTab, query: string) {
  const q = query.trim();
  if (!q) return;
  const rest = loadHistory().filter((e) => e.tab !== tab || e.query !== q);
  saveJson(HISTORY_KEY, [{ tab, query: q }, ...rest].slice(0, MAX_HISTORY));
}
