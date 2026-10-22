/**
 * Coverage suites of this project window: the last few runs stay selectable,
 * one is shown (editor gutter, project tree, Coverage tool window) until hidden.
 */
import { create } from "zustand";
import { setContext } from "@/platform/context";
import type { CoverageSuite, FileCoverage } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { setFileDecorations, type FileDecoration } from "@/workbench/contributions";
import { coverageBadges, coverageTree } from "./model";

/** Suites kept (IDEA keeps a list of recent suites to choose from). */
export const MAX_SUITES = 5;

export interface Suite {
  id: string;
  /** Run configuration name. */
  name: string;
  createdAt: number;
  data: CoverageSuite;
  byPath: Map<string, FileCoverage>;
}

interface CoverageState {
  /** Newest first. */
  suites: Suite[];
  activeId: string | null;
  /** Whether the active suite is shown in editors and the project tree. */
  visible: boolean;
}

export const useCoverage = create<CoverageState>(() => ({ suites: [], activeId: null, visible: false }));

let seq = 0;

export function activeSuite(s: CoverageState = useCoverage.getState()): Suite | null {
  return s.suites.find((x) => x.id === s.activeId) ?? null;
}

/** The shown coverage of `path`, if any. */
export function shownFileCoverage(path: string, s: CoverageState = useCoverage.getState()): FileCoverage | null {
  if (!s.visible) return null;
  return activeSuite(s)?.byPath.get(path) ?? null;
}

export function addSuite(name: string, data: CoverageSuite): Suite {
  const suite: Suite = {
    id: `suite${++seq}`,
    name,
    createdAt: Date.now(),
    data,
    byPath: new Map(data.files.map((f) => [f.path, f])),
  };
  useCoverage.setState((s) => ({ suites: [suite, ...s.suites].slice(0, MAX_SUITES), activeId: suite.id, visible: true }));
  return suite;
}

export function selectSuite(id: string) {
  useCoverage.setState({ activeId: id, visible: true });
}

export function closeSuite(id: string) {
  useCoverage.setState((s) => {
    const suites = s.suites.filter((x) => x.id !== id);
    const activeId = s.activeId === id ? (suites[0]?.id ?? null) : s.activeId;
    return { suites, activeId, visible: s.visible && !!activeId };
  });
}

export function setCoverageVisible(visible: boolean) {
  useCoverage.setState((s) => ({ visible: visible && !!s.activeId }));
}

export function resetCoverage() {
  useCoverage.setState({ suites: [], activeId: null, visible: false });
}

/** Keeps the `coverageVisible` context key and the project tree badges in sync. */
export function syncCoverageViews(): () => void {
  const apply = (s: CoverageState) => {
    setContext("coverageVisible", s.visible);
    setContext("coverageSuites", s.suites.length > 0);
    const suite = s.visible ? activeSuite(s) : null;
    const root = useProject.getState().project?.root;
    const decorations = new Map<string, FileDecoration>();
    if (suite && root) {
      for (const [path, badge] of coverageBadges(coverageTree(suite.data, root, false))) decorations.set(path, { badge });
    }
    setFileDecorations("coverage", decorations);
  };
  apply(useCoverage.getState());
  const unsub = useCoverage.subscribe((s, prev) => {
    if (s.visible !== prev.visible || s.activeId !== prev.activeId || s.suites !== prev.suites) apply(s);
  });
  return () => {
    unsub();
    setFileDecorations("coverage", new Map());
  };
}
