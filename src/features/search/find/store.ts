import { create } from "zustand";
import type { ProjectFileSet, SearchQuery, SearchScope } from "@/platform/ipc";
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
}

interface FindPopupState extends FindOptions {
  open: boolean;
  replace: boolean;
  session: number;
}

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
}));

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

export function buildQuery(o: FindOptions, scope: SearchScope, maxMatches: number): SearchQuery {
  return {
    pattern: o.pattern,
    isRegex: o.isRegex,
    caseSensitive: o.caseSensitive,
    wholeWord: o.wholeWord,
    include: o.maskEnabled && o.mask.trim() ? [o.mask.trim()] : [],
    exclude: [],
    scope,
    maxMatches,
  };
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
  return `'${q.pattern}' in ${where}${q.include.length ? ` (${q.include.join(", ")})` : ""}`;
}
