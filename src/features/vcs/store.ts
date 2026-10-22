/**
 * Repository state shared by all VCS views: working tree status, HEAD /
 * upstream info, branches and stashes. Refreshed (debounced) on `vcsChanged`
 * and `fsChanged` events and after every operation.
 */
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { create } from "zustand";
import type { Branch, BranchInfo, FileStatus, Stash } from "@/bindings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { setFileDecorations } from "@/workbench/contributions";
import { effectiveKind, statusDecorations, stripSlash } from "./model";

export interface VcsState {
  /** The open project is a git repository. */
  available: boolean;
  root: string | null;
  status: FileStatus[];
  /** `status` reflects the repository (false until the first refresh). */
  statusLoaded: boolean;
  /** Absolute path (no trailing slash) → status. */
  byPath: Map<string, FileStatus>;
  branch: BranchInfo | null;
  branches: Branch[];
  branchesLoaded: boolean;
  stashes: Stash[];
  stashesLoaded: boolean;
  /** Bumped after each refresh; gutters re-query hunks when it changes. */
  version: number;
  loading: boolean;
  error: string | null;
  /** A network operation (fetch / pull / push) is running. */
  remoteBusy: string | null;
}

const initial: VcsState = {
  available: false,
  root: null,
  status: [],
  statusLoaded: false,
  byPath: new Map(),
  branch: null,
  branches: [],
  branchesLoaded: false,
  stashes: [],
  stashesLoaded: false,
  version: 0,
  loading: false,
  error: null,
  remoteBusy: null,
};

export const useVcs = create<VcsState>(() => ({ ...initial }));

export function conflictedFiles(status: readonly FileStatus[] = useVcs.getState().status): FileStatus[] {
  return status.filter((f) => effectiveKind(f) === "conflicted");
}

let timer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> | null = null;
/** The refresh queued behind `inflight` (it may have started before the caller's change). */
let followUp: Promise<void> | null = null;
let conflictListener: ((files: FileStatus[]) => void) | null = null;
let conflictsClearedListener: (() => void) | null = null;

/** Called when the set of conflicted files becomes non-empty. */
export function onConflictsAppeared(fn: (files: FileStatus[]) => void) {
  conflictListener = fn;
}

/** Called when the last conflicted file is resolved (or the merge is aborted). */
export function onConflictsCleared(fn: () => void) {
  conflictsClearedListener = fn;
}

export function scheduleRefresh(delay = 200) {
  if (!useVcs.getState().available) return;
  clearTimeout(timer);
  timer = setTimeout(() => void refreshNow(), delay);
}

/**
 * Refreshes status + branch info now. Concurrent calls coalesce; the returned
 * promise always settles after a refresh that started after this call, so callers
 * that await it read the state their operation produced.
 */
export function refreshNow(): Promise<void> {
  if (!useVcs.getState().available) return Promise.resolve();
  if (inflight) {
    followUp ??= inflight.then(() => {
      followUp = null;
      return refreshNow();
    });
    return followUp;
  }
  inflight = (async () => {
    useVcs.setState({ loading: true });
    try {
      const s = useVcs.getState();
      const [status, branch, branches, stashes] = await Promise.all([
        call(commands.vcsStatus()),
        call(commands.vcsBranchInfo()),
        s.branchesLoaded ? call(commands.vcsBranches()) : Promise.resolve(s.branches),
        s.stashesLoaded ? call(commands.vcsStashes()) : Promise.resolve(s.stashes),
      ]);
      applyStatus(status, branch);
      useVcs.setState({ branches, stashes, error: null });
    } catch (e) {
      useVcs.setState({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      useVcs.setState((st) => ({ loading: false, version: st.version + 1 }));
      inflight = null;
    }
  })();
  return inflight;
}

export function applyStatus(status: FileStatus[], branch: BranchInfo | null) {
  const before = conflictedFiles().length;
  const byPath = new Map(status.map((f) => [stripSlash(f.path), f]));
  useVcs.setState({ status, byPath, branch, statusLoaded: true });
  setFileDecorations("vcs", statusDecorations(status, workflowSettings().vcs.showDirtyDirectories));
  const conflicts = conflictedFiles(status);
  if (before === 0 && conflicts.length > 0) conflictListener?.(conflicts);
  else if (before > 0 && conflicts.length === 0) conflictsClearedListener?.();
}

export async function loadBranches(): Promise<Branch[]> {
  const branches = await call(commands.vcsBranches());
  useVcs.setState({ branches, branchesLoaded: true });
  return branches;
}

export async function loadStashes(): Promise<Stash[]> {
  const stashes = await call(commands.vcsStashes());
  useVcs.setState({ stashes, stashesLoaded: true });
  return stashes;
}

export function statusOf(path: string): FileStatus | undefined {
  return useVcs.getState().byPath.get(stripSlash(path));
}

/** Tracks the open project and backend events. Returns a disposer. */
export function installVcsStore(): () => void {
  const onProject = () => {
    const project = useProject.getState().project;
    const available = !!project?.isGit;
    const root = project?.root ?? null;
    if (useVcs.getState().root === root && useVcs.getState().available === available) return;
    clearTimeout(timer);
    useVcs.setState({ ...initial, available, root, version: useVcs.getState().version + 1 });
    setContext("vcsAvailable", available);
    setFileDecorations("vcs", new Map());
    if (available && isTauri()) void refreshNow();
  };
  onProject();
  const unsubProject = useProject.subscribe((s, prev) => {
    if (s.project !== prev.project) onProject();
  });
  const offVcs = onIdeEvent("vcsChanged", () => scheduleRefresh(200));
  const offFs = onIdeEvent("fsChanged", () => scheduleRefresh(250));
  const offSettings = onWorkflowSettingsChange(
    (s) => s.vcs.showDirtyDirectories,
    (show) => {
      if (useVcs.getState().available) setFileDecorations("vcs", statusDecorations(useVcs.getState().status, show));
    },
  );
  return () => {
    offSettings();
    clearTimeout(timer);
    unsubProject();
    offVcs();
    offFs();
    setContext("vcsAvailable", false);
    setFileDecorations("vcs", new Map());
  };
}
