/** Find Usages (⌥F7 → "usages" tool window) and Show Usages (⌥⌘F7 → popup). */
import { create } from "zustand";
import type { Location } from "@/bindings";
import { commands, isCancelled } from "@/platform/ipc";
import { toolWindowService } from "@/workbench/contributions";
import {
  caretContext,
  caretPoint,
  hint,
  lspRequest,
  openLocation,
  readManyFileLines,
  reportError,
  type CaretContext,
} from "./ipc";
import { syntaxUsages } from "./syntaxUsages";

export interface Usage {
  path: string;
  line: number;
  col: number;
  /** End column on `line` (clamped to the line for multi-line ranges). */
  endCol: number;
  /** The usage's line text (empty when the file couldn't be read). */
  text: string;
}

export interface UsageGroup {
  path: string;
  usages: Usage[];
}

/** Groups reference locations by file (sorted by path, then position), attaching line previews. */
export function groupUsages(locs: readonly Location[], files: ReadonlyMap<string, readonly string[] | null>): UsageGroup[] {
  const byPath = new Map<string, Usage[]>();
  const seen = new Set<string>();
  for (const l of locs) {
    const key = `${l.path}:${l.range.start.line}:${l.range.start.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = files.get(l.path)?.[l.range.start.line] ?? "";
    const endCol = l.range.end.line === l.range.start.line ? l.range.end.col : Math.max(text.length, l.range.start.col);
    let list = byPath.get(l.path);
    if (!list) byPath.set(l.path, (list = []));
    list.push({ path: l.path, line: l.range.start.line, col: l.range.start.col, endCol, text });
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, usages]) => ({ path, usages: usages.sort((a, b) => a.line - b.line || a.col - b.col) }));
}

export function usageCount(groups: readonly UsageGroup[]): number {
  return groups.reduce((n, g) => n + g.usages.length, 0);
}

/** Trims leading whitespace of a preview line, shifting the match range accordingly. */
export function trimPreview(u: Usage): { text: string; from: number; to: number } {
  const lead = u.text.length - u.text.trimStart().length;
  const text = u.text.trim();
  const from = Math.max(0, u.col - lead);
  const to = Math.max(from, Math.min(text.length, u.endCol - lead));
  return { text, from, to };
}

interface UsageSearch {
  /** Identifies one search run (UI state such as expansion resets per run). */
  id: number;
  symbol: string | null;
  loading: boolean;
  groups: UsageGroup[];
  error: string | null;
  /** Results came from the syntax fallback: says so (e.g. "Text occurrences (language server not ready)"). */
  note: string | null;
  /** Re-runs the same query (rerun button). */
  rerun: (() => void) | null;
}

let searchSeq = 0;

export const useUsages = create<{ search: UsageSearch | null }>(() => ({ search: null }));

interface UsagesPopupState {
  open: boolean;
  anchor: { x: number; y: number };
  symbol: string | null;
  groups: UsageGroup[];
  note: string | null;
}

export const useUsagesPopup = create<UsagesPopupState>(() => ({
  open: false,
  anchor: { x: 0, y: 0 },
  symbol: null,
  groups: [],
  note: null,
}));

interface FetchedUsages {
  groups: UsageGroup[];
  note: string | null;
}

/**
 * The server's references; when it is not ready or fails, the syntax fallback
 * (an empty server answer is respected). Without a fallback the server error stands.
 */
export async function fetchUsages(c: CaretContext): Promise<FetchedUsages> {
  let locs: Location[];
  let note: string | null = null;
  try {
    locs = await lspRequest(() => commands.lspReferences(c.doc, { line: c.line, col: c.col }, false));
  } catch (e) {
    if (isCancelled(e)) throw e;
    let fb = null;
    try {
      fb = await syntaxUsages(c);
    } catch (fe) {
      if (isCancelled(fe)) throw fe;
      console.debug("[syntax] usages fallback", fe);
    }
    if (!fb) throw e;
    locs = fb.locs;
    note = fb.note;
  }
  const files = await readManyFileLines(locs.map((l) => l.path));
  return { groups: groupUsages(locs, files), note };
}

export async function findUsages() {
  const c = caretContext();
  if (!c) {
    hint("Open a file to find usages");
    return;
  }
  const run = async () => {
    const id = ++searchSeq;
    const current = () => useUsages.getState().search?.id === id;
    const base = { id, symbol: c.word, rerun: () => void run() };
    useUsages.setState({ search: { ...base, loading: true, groups: [], error: null, note: null } });
    toolWindowService().show("usages");
    try {
      const { groups, note } = await fetchUsages(c);
      if (current()) useUsages.setState({ search: { ...base, loading: false, groups, error: null, note } });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!current()) return;
      useUsages.setState({ search: { ...base, loading: false, groups: [], error: message, note: null } });
      reportError(e);
    }
  };
  await run();
}

/**
 * Shows already-found usages in the tool window (Safe Delete's "View Usages").
 * Ignores malformed arguments.
 */
export async function showUsageResults(arg: unknown) {
  const a = (arg ?? {}) as { symbol?: unknown; locations?: unknown };
  if (!Array.isArray(a.locations)) return;
  const locs = a.locations as Location[];
  const symbol = typeof a.symbol === "string" ? a.symbol : null;
  const id = ++searchSeq;
  const base = { id, symbol, rerun: null };
  useUsages.setState({ search: { ...base, loading: true, groups: [], error: null, note: null } });
  toolWindowService().show("usages");
  const files = await readManyFileLines(locs.map((l) => l.path));
  if (useUsages.getState().search?.id !== id) return;
  useUsages.setState({ search: { ...base, loading: false, groups: groupUsages(locs, files), error: null, note: null } });
}

export async function showUsagesPopup() {
  const c = caretContext();
  if (!c) {
    hint("Open a file to show usages");
    return;
  }
  try {
    const { groups, note } = await fetchUsages(c);
    const total = usageCount(groups);
    if (!total) {
      hint(c.word ? `No usages of '${c.word}' found` : "No usages found");
      return;
    }
    if (total === 1) {
      const u = groups[0]!.usages[0]!;
      openLocation(u.path, u.line, u.col);
      return;
    }
    useUsagesPopup.setState({ open: true, anchor: caretPoint(), symbol: c.word, groups, note });
  } catch (e) {
    reportError(e);
  }
}
