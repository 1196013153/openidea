import { create } from "zustand";
import type { ProjectFileSet, SearchContext, SearchQuery, SearchScope } from "@/platform/ipc";
import { loadJson, saveJson } from "../common/open";

export type ScopeTab = "project" | "directory" | "scope";
export type NamedScope = "projectFiles" | "productionFiles" | "testFiles" | "openFiles" | "recentFiles";

/** IDEA's root-based named scopes, searched by the backend over the project's source / test roots. */
export const FILE_SET_SCOPES: Partial<Record<NamedScope, ProjectFileSet>> = {
  projectFiles: "all",
  productionFiles: "production",
  testFiles: "test",
};

const FILE_SET_LABELS: Record<ProjectFileSet, string> = {
  all: "Project Files",
  production: "Project Production Files",
  test: "Project Test Files",
};

export interface FindOptions {
  pattern: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  /** Replace: keep the case of each found occurrence (IDEA's "Preserve case"). */
  preserveCase: boolean;
  maskEnabled: boolean;
  mask: string;
  scopeTab: ScopeTab;
  directory: string;
  namedScope: NamedScope;
  /** IDEA's search context filter (funnel menu): anywhere, only / except comments and string literals. */
  context: SearchContext;
}

interface FindPopupState extends FindOptions {
  open: boolean;
  replace: boolean;
  session: number;
  /** Title-bar pin: the popup stays open when a result is opened or the user clicks outside. */
  pinned: boolean;
}

const PINNED_KEY = "openidea.search.findPinned.v1";

export const useFindPopup = create<FindPopupState>(() => ({
  open: false,
  replace: false,
  session: 0,
  pattern: "",
  replacement: "",
  caseSensitive: false,
  wholeWord: false,
  isRegex: false,
  preserveCase: false,
  maskEnabled: false,
  mask: "",
  scopeTab: "project",
  directory: "",
  namedScope: "projectFiles",
  context: "any",
  pinned: loadJson<unknown>(PINNED_KEY, false) === true,
}));

export function setFindPopupPinned(pinned: boolean) {
  useFindPopup.setState({ pinned });
  saveJson(PINNED_KEY, pinned);
}

export const SEARCH_CONTEXTS: ReadonlyArray<{ value: SearchContext; label: string }> = [
  { value: "any", label: "Anywhere" },
  { value: "inComments", label: "In Comments" },
  { value: "inStringLiterals", label: "In String Literals" },
  { value: "exceptComments", label: "Except Comments" },
  { value: "exceptStringLiterals", label: "Except String Literals" },
  { value: "exceptCommentsAndStringLiterals", label: "Except Comments and String Literals" },
];

/**
 * Keys the popup handles that are also global shortcuts (⌘G / ⇧⌘G, F4 / ⌘↓, ⌥↓):
 * hidden actions bound later in the keymap win while the popup is open and
 * forward here.
 */
export type FindPopupCommand = "nextResult" | "previousResult" | "openResult" | "recentSearches";
let commandHandler: ((c: FindPopupCommand) => void) | null = null;

export function setFindPopupCommandHandler(handler: ((c: FindPopupCommand) => void) | null) {
  commandHandler = handler;
}

export function runFindPopupCommand(c: FindPopupCommand): boolean {
  if (!useFindPopup.getState().open || !commandHandler) return false;
  commandHandler(c);
  return true;
}

export interface FindArg {
  directory?: string;
  query?: string;
}

export function parseFindArg(arg: unknown): FindArg {
  if (!arg || typeof arg !== "object") return {};
  const a = arg as Record<string, unknown>;
  return {
    directory: typeof a.directory === "string" ? a.directory : typeof a.path === "string" ? a.path : undefined,
    query: typeof a.query === "string" ? a.query : undefined,
  };
}

export function showFindPopup(replace: boolean, arg: FindArg & { selection?: string | null } = {}) {
  const s = useFindPopup.getState();
  const patch: Partial<FindPopupState> = { open: true, replace, session: s.session + 1 };
  const prefill = arg.query ?? arg.selection;
  if (prefill) patch.pattern = prefill;
  if (arg.directory) {
    patch.scopeTab = "directory";
    patch.directory = arg.directory;
  } else if (!s.open && s.scopeTab === "directory" && !s.directory) {
    patch.scopeTab = "project";
  }
  useFindPopup.setState(patch);
}

export function hideFindPopup() {
  useFindPopup.setState({ open: false });
}

const MASKS_KEY = "openidea.search.fileMasks.v1";
const DEFAULT_MASKS = ["*.ts,*.tsx", "*.rs", "*.kt", "*.java", "*.py", "*.go", "*.md", "*.json", "!*.test.*"];

export function recentMasks(): string[] {
  const v = loadJson<unknown>(MASKS_KEY, []);
  const recent = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return [...recent, ...DEFAULT_MASKS.filter((m) => !recent.includes(m))];
}

export function rememberMask(mask: string) {
  const m = mask.trim();
  if (!m) return;
  const v = loadJson<unknown>(MASKS_KEY, []);
  const recent = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  saveJson(MASKS_KEY, [m, ...recent.filter((x) => x !== m)].slice(0, 10));
}

const HISTORY_KEYS = { find: "openidea.search.findHistory.v1", replace: "openidea.search.replaceHistory.v1" };
const MAX_HISTORY = 20;

/** Recent search (or replace) strings of the Find in Files popup, newest first (⌥↓). */
export function findHistory(kind: "find" | "replace"): string[] {
  const v = loadJson<unknown>(HISTORY_KEYS[kind], []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function rememberFindString(kind: "find" | "replace", text: string) {
  if (!text.trim()) return;
  saveJson(HISTORY_KEYS[kind], [text, ...findHistory(kind).filter((x) => x !== text)].slice(0, MAX_HISTORY));
}

export function buildQuery(o: FindOptions, scope: SearchScope, maxMatches: number): SearchQuery {
  const q: SearchQuery = {
    pattern: o.pattern,
    isRegex: o.isRegex,
    caseSensitive: o.caseSensitive,
    wholeWord: o.wholeWord,
    include: o.maskEnabled && o.mask.trim() ? [o.mask.trim()] : [],
    exclude: [],
    scope,
    maxMatches,
  };
  if (o.context !== "any") q.context = o.context;
  return q;
}

export function describeQuery(q: SearchQuery, root: string | null): string {
  const where =
    q.scope.kind === "project"
      ? "Project"
      : q.scope.kind === "directory"
        ? `Directory ${root && q.scope.path.startsWith(root + "/") ? q.scope.path.slice(root.length + 1) : q.scope.path}`
        : q.scope.kind === "fileSet"
          ? FILE_SET_LABELS[q.scope.set]
          : `${q.scope.paths.length} files`;
  const context = q.context && q.context !== "any" ? SEARCH_CONTEXTS.find((c) => c.value === q.context)?.label : null;
  return `'${q.pattern}' in ${where}${q.include.length ? ` (${q.include.join(", ")})` : ""}${context ? `, ${context.toLowerCase()}` : ""}`;
}
