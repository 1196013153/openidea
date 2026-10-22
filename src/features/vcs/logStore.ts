/** Git log tool window state: filters, paged commits, graph, selection. */
import { create } from "zustand";
import type { Branch, BranchInfo, Commit } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { computeGraph, emptyGraphState, type GraphRow, type GraphState } from "./graph";
import { clearConsole, errorMessage } from "./ops";
import { useVcs } from "./store";

export interface LogFilters {
  branch: string | null;
  author: string;
  text: string;
  /** `text` is a regular expression / matches case-sensitively. */
  regex: boolean;
  matchCase: boolean;
  /** Absolute path (file or directory). */
  path: string | null;
  /** Only commits newer than `ms` (epoch); applied client-side. */
  since: { ms: number; label: string } | null;
}

interface LogState {
  filters: LogFilters;
  commits: Commit[];
  rows: GraphRow[];
  graph: GraphState;
  loading: boolean;
  done: boolean;
  error: string | null;
  /** Lead selection. */
  selected: string | null;
  /** Every selected commit id (includes `selected`), in selection order. */
  selection: string[];
  /** Commits of HEAD not on its upstream (`@{u}..HEAD`); null without an upstream. */
  outgoing: Set<string> | null;
  tab: "log" | "console";
  /** Bumped to ask the list to scroll the selection into view. */
  revealTick: number;
  generation: number;
}

export const PAGE = 300;

export const emptyFilters = (): LogFilters => ({
  branch: null,
  author: "",
  text: "",
  regex: false,
  matchCase: false,
  path: null,
  since: null,
});

const initialLog = (): Omit<LogState, "generation"> => ({
  filters: emptyFilters(),
  commits: [],
  rows: [],
  graph: emptyGraphState(),
  loading: false,
  done: false,
  error: null,
  selected: null,
  selection: [],
  outgoing: null,
  tab: "log",
  revealTick: 0,
});

export const useGitLog = create<LogState>(() => ({ ...initialLog(), generation: 0 }));

let loadPromise: Promise<void> | null = null;

/** Another repository (the window switched projects): forget its commits, filters, selection and console. */
export function installGitLog(): () => void {
  return useVcs.subscribe((s, prev) => {
    if (s.root === prev.root) return;
    loadPromise = null;
    useGitLog.setState((l) => ({ ...initialLog(), tab: l.tab, generation: l.generation + 1 }));
    clearConsole();
  });
}

export function setLogFilters(patch: Partial<LogFilters>) {
  useGitLog.setState((s) => ({ filters: { ...s.filters, ...patch } }));
  void reloadLog();
}

/** Drops loaded commits and loads the first page. */
export function reloadLog(): Promise<void> {
  useGitLog.setState((s) => ({
    commits: [],
    rows: [],
    graph: emptyGraphState(),
    done: false,
    error: null,
    generation: s.generation + 1,
  }));
  loadPromise = null;
  void loadOutgoing();
  return loadMore();
}

async function loadOutgoing() {
  const upstream = useVcs.getState().branch?.upstream;
  if (!upstream) return useGitLog.setState({ outgoing: null });
  try {
    const commits = await call(
      commands.vcsLog({ branch: "HEAD", path: null, author: null, text: null, range: "@{u}..HEAD", skip: 0, limit: 0 }),
    );
    useGitLog.setState({ outgoing: new Set(commits.map((c) => c.id)) });
  } catch {
    useGitLog.setState({ outgoing: null });
  }
}

/** The commit is on the upstream of the current branch (rewriting it needs a force push). */
export function isPushed(id: string): boolean {
  const { outgoing } = useGitLog.getState();
  return !!outgoing && !outgoing.has(id);
}

export function loadMore(): Promise<void> {
  const s = useGitLog.getState();
  if (s.done) return Promise.resolve();
  if (loadPromise) return loadPromise;
  const gen = s.generation;
  const f = s.filters;
  // Settings › Version Control › Limit history to N rows (file / folder history).
  const vcs = workflowSettings().vcs;
  const cap = f.path && vcs.limitHistory ? vcs.historyLimit : Infinity;
  if (s.commits.length >= cap) {
    useGitLog.setState({ done: true });
    return Promise.resolve();
  }
  useGitLog.setState({ loading: true });
  const p = (async () => {
    try {
      const page = await call(
        commands.vcsLog({
          branch: f.branch,
          path: f.path,
          author: f.author.trim() || null,
          text: f.text.trim() || null,
          textRegex: f.regex,
          textMatchCase: f.matchCase,
          range: null,
          skip: s.commits.length,
          limit: Math.min(PAGE, cap - s.commits.length),
        }),
      );
      const cur = useGitLog.getState();
      if (cur.generation !== gen) return;
      const { rows, state } = computeGraph(page, cur.graph);
      useGitLog.setState({
        commits: cur.commits.concat(page),
        rows: cur.rows.concat(rows),
        graph: state,
        done: page.length < PAGE || cur.commits.length + page.length >= cap,
        error: null,
      });
    } catch (e) {
      if (useGitLog.getState().generation === gen) useGitLog.setState({ error: errorMessage(e), done: true });
    } finally {
      if (useGitLog.getState().generation === gen) {
        useGitLog.setState({ loading: false });
        loadPromise = null;
      }
    }
  })();
  loadPromise = p;
  return p;
}

/**
 * What the log shows depends on: HEAD and every branch tip. When this changes
 * (commit, undo, reset, rebase, fetch, branch created / deleted) the log is stale.
 */
export function refsSignature(head: BranchInfo | null, branches: readonly Branch[]): string {
  const tips = branches.map((b) => `${b.remote ? "r" : "l"}:${b.name}@${b.commit}`).sort();
  return [`HEAD:${head?.head ?? ""}@${head?.headCommit ?? ""}`, ...tips].join("\n");
}

export function selectCommit(id: string | null, reveal = false) {
  useGitLog.setState((s) => ({
    selected: id,
    selection: id ? [id] : [],
    revealTick: reveal ? s.revealTick + 1 : s.revealTick,
  }));
}

/** Cmd/Ctrl-click: toggles `id` in the selection. */
export function toggleCommitSelection(id: string) {
  useGitLog.setState((s) => {
    const on = s.selection.includes(id);
    const selection = on ? s.selection.filter((x) => x !== id) : [...s.selection, id];
    return { selection, selected: on ? (selection[selection.length - 1] ?? null) : id };
  });
}

/** Shift-click / Shift+arrows: selects the rows between the anchor (lead) and `id` within `visible`. */
export function extendCommitSelection(id: string, visible: readonly Commit[]) {
  useGitLog.setState((s) => {
    const anchor = s.selection[0] ?? s.selected;
    const a = anchor ? visible.findIndex((c) => c.id === anchor) : -1;
    const b = visible.findIndex((c) => c.id === id);
    if (a < 0 || b < 0) return { selected: id, selection: [id] };
    const [from, to] = a <= b ? [a, b] : [b, a];
    const range = visible.slice(from, to + 1).map((c) => c.id);
    // Keep the anchor first so further extensions pivot on it.
    return { selected: id, selection: [anchor!, ...range.filter((x) => x !== anchor)] };
  });
}

/** Selected commits, newest first (log order). */
export function selectedCommits(): Commit[] {
  const { commits, selection } = useGitLog.getState();
  const ids = new Set(selection);
  return commits.filter((c) => ids.has(c.id));
}

const MAX_SEARCH_PAGES = 30;

/** Selects `id` in the log, clearing filters and paging until it is loaded. */
export async function revealCommit(id: string) {
  useGitLog.setState({ tab: "log" });
  const f = useGitLog.getState().filters;
  const filtered = f.branch || f.author || f.text || f.path || f.since;
  const find = () => useGitLog.getState().commits.find((c) => c.id === id || c.id.startsWith(id));
  if (filtered) {
    useGitLog.setState({ filters: emptyFilters() });
    await reloadLog();
  } else if (!useGitLog.getState().commits.length) {
    await reloadLog();
  }
  for (let i = 0; i < MAX_SEARCH_PAGES && !find() && !useGitLog.getState().done; i++) await loadMore();
  const hit = find();
  if (hit) selectCommit(hit.id, true);
}

/** Go to Parent Commit: selects the first parent, paging the log until it is loaded. */
export async function goToParent(c: Commit) {
  const parent = c.parents[0];
  if (!parent) return;
  const find = () => useGitLog.getState().commits.find((x) => x.id === parent);
  for (let i = 0; i < MAX_SEARCH_PAGES && !find() && !useGitLog.getState().done; i++) await loadMore();
  if (find()) selectCommit(parent, true);
}

/** Go to Child Commit: the nearest newer loaded commit having `c` as a parent. */
export function goToChild(c: Commit) {
  const { commits } = useGitLog.getState();
  const index = commits.findIndex((x) => x.id === c.id);
  for (let i = index - 1; i >= 0; i--) {
    if (commits[i]!.parents.includes(c.id)) return selectCommit(commits[i]!.id, true);
  }
}
