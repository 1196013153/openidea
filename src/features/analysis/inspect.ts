/**
 * Inspect Code: batch language-server diagnostics over a scope, grouped
 * like IDEA's Inspection Results (severity → inspection → file → problem).
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  call,
  commands,
  isTauri,
  nextRequestId,
  type Diagnostic,
  type InspectEvent,
  type InspectSummary,
  type RequestId,
} from "@/platform/ipc";
import { notifications, toolWindowService } from "@/workbench/contributions";
import { describeScope, resolveScope, type ScopeChoice } from "./scope";

export type SeverityKey = "error" | "warning" | "info";

export interface InspectionProblem {
  path: string;
  relPath: string;
  d: Diagnostic;
}

export interface InspectionFileGroup {
  path: string;
  relPath: string;
  problems: InspectionProblem[];
}

export interface InspectionKindGroup {
  /** `source` or `source(code)`, e.g. `eslint(no-unused-vars)`. */
  kind: string;
  count: number;
  files: InspectionFileGroup[];
}

export interface InspectionSeverityGroup {
  severity: SeverityKey;
  count: number;
  kinds: InspectionKindGroup[];
}

export interface InspectedFileResult {
  path: string;
  relPath: string;
  diagnostics: Diagnostic[];
}

const SEVERITY_ORDER: SeverityKey[] = ["error", "warning", "info"];

export const severityKey = (d: Diagnostic): SeverityKey => (d.severity === "hint" ? "info" : d.severity);

export function kindOf(d: Diagnostic): string {
  const source = d.source || "Language server";
  return d.code ? `${source}(${d.code})` : source;
}

/** Groups results by severity, then inspection kind, then file (all sorted). */
export function groupInspection(files: Iterable<InspectedFileResult>): InspectionSeverityGroup[] {
  const tree = new Map<SeverityKey, Map<string, Map<string, InspectionFileGroup>>>();
  for (const f of files) {
    for (const d of f.diagnostics) {
      const sev = severityKey(d);
      let kinds = tree.get(sev);
      if (!kinds) tree.set(sev, (kinds = new Map()));
      const kind = kindOf(d);
      let byFile = kinds.get(kind);
      if (!byFile) kinds.set(kind, (byFile = new Map()));
      let group = byFile.get(f.path);
      if (!group) byFile.set(f.path, (group = { path: f.path, relPath: f.relPath, problems: [] }));
      group.problems.push({ path: f.path, relPath: f.relPath, d });
    }
  }
  const pos = (p: InspectionProblem) => [p.d.range.start.line, p.d.range.start.col] as const;
  return SEVERITY_ORDER.filter((s) => tree.has(s)).map((severity) => {
    const kinds = [...tree.get(severity)!.entries()]
      .map(([kind, byFile]) => {
        const groups = [...byFile.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
        for (const g of groups) g.problems.sort((a, b) => pos(a)[0] - pos(b)[0] || pos(a)[1] - pos(b)[1]);
        return { kind, count: groups.reduce((n, g) => n + g.problems.length, 0), files: groups };
      })
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
    return { severity, count: kinds.reduce((n, k) => n + k.count, 0), kinds };
  });
}

interface InspectState {
  running: boolean;
  total: number;
  done: number;
  /** Files with problems, by path. */
  files: Map<string, InspectedFileResult>;
  summary: InspectSummary | null;
  scopeLabel: string | null;
  error: string | null;
  /** Scope of the last run (Rerun). */
  last: ScopeChoice | null;
}

const initialInspection = (): InspectState => ({
  running: false,
  total: 0,
  done: 0,
  files: new Map(),
  summary: null,
  scopeLabel: null,
  error: null,
  last: null,
});

export const useInspection = create<InspectState>(initialInspection);

let inflight: RequestId | null = null;

export function cancelInspection() {
  if (inflight === null) return;
  void commands.cancelRequest(inflight).catch(() => undefined);
}

/** The window switched projects: stops the run and forgets its results. */
export function resetInspection() {
  cancelInspection();
  inflight = null;
  useInspection.setState(initialInspection());
}

export async function runInspection(choice: ScopeChoice): Promise<void> {
  const scope = await resolveScope(choice);
  if (typeof scope === "string") {
    notifications().notify({ group: "analysis", level: "warning", title: "Inspect Code", body: scope });
    return;
  }
  cancelInspection();
  const id = nextRequestId();
  inflight = id;
  useInspection.setState({
    running: true,
    total: 0,
    done: 0,
    files: new Map(),
    summary: null,
    error: null,
    scopeLabel: describeScope(choice, scope),
    last: choice,
  });
  toolWindowService().show("inspection");
  if (!isTauri()) {
    useInspection.setState({ running: false, error: "Inspect Code needs the desktop app" });
    return;
  }
  const found = new Map<string, InspectedFileResult>();
  let flush: ReturnType<typeof setTimeout> | null = null;
  const publish = () => {
    flush = null;
    if (inflight === id) useInspection.setState({ files: new Map(found) });
  };
  const channel = new Channel<InspectEvent>();
  channel.onmessage = (ev) => {
    if (inflight !== id) return;
    switch (ev.type) {
      case "started":
        useInspection.setState({ total: ev.total });
        break;
      case "file":
        if (ev.file.diagnostics.length) found.set(ev.file.path, ev.file);
        useInspection.setState({ done: ev.done });
        flush ??= setTimeout(publish, 150);
        break;
      case "done":
        if (flush) clearTimeout(flush);
        inflight = null;
        useInspection.setState({ running: false, files: new Map(found), summary: ev.summary });
        break;
    }
  };
  try {
    await call(commands.inspectCode(id, scope, channel));
  } catch (e) {
    if (inflight === id) {
      inflight = null;
      useInspection.setState({ running: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

export function rerunInspection() {
  const last = useInspection.getState().last;
  if (last) void runInspection(last);
}
