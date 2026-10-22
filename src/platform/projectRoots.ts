/**
 * Source / test / resource / excluded roots of the open project: detected by
 * the backend from build files (`project_roots`, refreshed on
 * `projectRootsChanged`) and merged here with the Project Structure settings,
 * so marking a folder shows at once.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { call, commands, isTauri, onIdeEvent } from "./ipc";
import {
  effectiveRoots,
  isTestPath,
  rootFor,
  useProjectStructure,
  validateProjectStructure,
  type RootFolder,
} from "./languageSettings";
import { useProject } from "./project";

interface RootsState {
  /** Project the roots belong to. */
  root: string | null;
  detected: RootFolder[];
}

export const useProjectRoots = create<RootsState>(() => ({ root: null, detected: [] }));

let generation = 0;

/** Re-reads the detected roots of the open project. */
export async function loadProjectRoots(): Promise<void> {
  const root = useProject.getState().project?.root ?? null;
  const gen = ++generation;
  if (!root || !isTauri()) {
    useProjectRoots.setState({ root, detected: [] });
    return;
  }
  try {
    const roots = await call(commands.projectRoots());
    if (gen !== generation) return;
    useProjectRoots.setState({
      root,
      detected: roots.detected.map((r) => ({ path: r.path, kind: r.kind, detectedFrom: r.detectedFrom ?? null })),
    });
  } catch {
    if (gen === generation) useProjectRoots.setState({ root, detected: [] });
  }
}

let users = 0;
let dispose: (() => void) | null = null;

/** Keeps the roots in sync with the open project (reference-counted; returns a disposer). */
export function initProjectRoots(): () => void {
  if (users++ === 0) {
    void loadProjectRoots();
    const unsubProject = useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) void loadProjectRoots();
    });
    const unsubEvent = onIdeEvent("projectRootsChanged", () => void loadProjectRoots());
    dispose = () => {
      unsubProject();
      unsubEvent();
    };
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--users === 0) {
      dispose?.();
      dispose = null;
    }
  };
}

function currentDetected(): RootFolder[] {
  const s = useProjectRoots.getState();
  return s.root === (useProject.getState().project?.root ?? null) ? s.detected : [];
}

/** Effective roots right now (non-reactive). */
export function currentRoots(): RootFolder[] {
  return effectiveRoots(currentDetected(), validateProjectStructure(useProject.getState().settings?.projectStructure));
}

/** Detected roots of the open project right now (non-reactive). */
export function currentDetectedRoots(): RootFolder[] {
  return currentDetected();
}

/** Effective roots (reactive). */
export function useEffectiveRoots(): RootFolder[] {
  const structure = useProjectStructure();
  const projectRoot = useProject((s) => s.project?.root ?? null);
  const detected = useProjectRoots((s) => (s.root === projectRoot ? s.detected : null));
  return useMemo(() => effectiveRoots(detected ?? [], structure), [detected, structure]);
}

/** Detected roots (reactive). */
export function useDetectedRoots(): RootFolder[] {
  const projectRoot = useProject((s) => s.project?.root ?? null);
  const detected = useProjectRoots((s) => (s.root === projectRoot ? s.detected : null));
  return detected ?? EMPTY;
}

const EMPTY: RootFolder[] = [];

/** Project-relative path of an absolute `path`, or null outside the project. */
export function projectRelative(path: string): string | null {
  const root = useProject.getState().project?.root;
  if (!root) return null;
  if (path === root) return "";
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : null;
}

/** The innermost root containing the absolute `path`. */
export function rootOfPath(path: string, roots: readonly RootFolder[] = currentRoots()): RootFolder | null {
  const rel = projectRelative(path);
  return rel === null ? null : rootFor(roots, rel);
}

/** Whether the absolute `path` is a test file (test root or test-file name). */
export function isTestFile(path: string, roots: readonly RootFolder[] = currentRoots()): boolean {
  const rel = projectRelative(path);
  return rel !== null && isTestPath(roots, rel);
}

/** IDEA's named scopes over the roots. */
export type ProjectFileSet = "all" | "production" | "test";

/** Whether the absolute `path` belongs to a named project scope ("Project Production Files" …). */
export function inFileSet(set: ProjectFileSet, path: string, roots: readonly RootFolder[] = currentRoots()): boolean {
  const rel = projectRelative(path);
  if (rel === null) return false;
  const root = rootFor(roots, rel);
  if (root?.kind === "excluded") return false;
  if (set === "all") return true;
  return isTestPath(roots, rel) === (set === "test");
}
