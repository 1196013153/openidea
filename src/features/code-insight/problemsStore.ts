/**
 * Project-wide diagnostics for the Problems tool window, status bar and file
 * decorations. The backend sends full replacements per (file, producer), so
 * the store keeps one list per source and merges them per file.
 */
import { create } from "zustand";
import type { Diagnostic, Severity } from "@/bindings";
import { onIdeEvent } from "@/platform/ipc";

export type FileDiagnostics = ReadonlyMap<string, readonly Diagnostic[]>;
/** path → source → diagnostics. */
export type ProblemsMap = ReadonlyMap<string, FileDiagnostics>;

export interface SeverityCounts {
  error: number;
  warning: number;
  info: number;
  hint: number;
}

/** Replaces `source`'s diagnostics for `path`; returns the same map when nothing changed. */
export function mergeDiagnostics(map: ProblemsMap, path: string, source: string, items: readonly Diagnostic[]): ProblemsMap {
  const prev = map.get(path);
  if (!items.length && !prev?.has(source)) return map;
  const next = new Map(map);
  const sources = new Map(prev ?? []);
  if (items.length) sources.set(source, items.map((d) => (d.source ? d : { ...d, source })));
  else sources.delete(source);
  if (sources.size) next.set(path, sources);
  else next.delete(path);
  return next;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** All diagnostics of a file across sources, ordered by position then severity. */
export function fileDiagnostics(map: ProblemsMap, path: string): Diagnostic[] {
  const sources = map.get(path);
  if (!sources) return [];
  return [...sources.values()]
    .flat()
    .sort(
      (a, b) =>
        a.range.start.line - b.range.start.line ||
        a.range.start.col - b.range.start.col ||
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
}

export function countSeverities(diags: Iterable<Diagnostic>): SeverityCounts {
  const c: SeverityCounts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const d of diags) c[d.severity]++;
  return c;
}

export function projectCounts(map: ProblemsMap): SeverityCounts {
  const c: SeverityCounts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const sources of map.values()) for (const items of sources.values()) for (const d of items) c[d.severity]++;
  return c;
}

export function worstSeverity(diags: Iterable<Diagnostic>): Severity | null {
  let best: Severity | null = null;
  for (const d of diags) if (best === null || SEVERITY_ORDER[d.severity] < SEVERITY_ORDER[best]) best = d.severity;
  return best;
}

interface ProblemsState {
  map: ProblemsMap;
}

export const useProblems = create<ProblemsState>(() => ({ map: new Map() }));

export function applyDiagnosticsEvent(path: string, source: string, items: readonly Diagnostic[]) {
  useProblems.setState((s) => {
    const map = mergeDiagnostics(s.map, path, source, items);
    return map === s.map ? s : { map };
  });
}

export function clearProblems() {
  useProblems.setState({ map: new Map() });
}

export function installProblemsEvents(): () => void {
  return onIdeEvent("diagnostics", (e) => applyDiagnosticsEvent(e.path, e.source, e.items));
}
