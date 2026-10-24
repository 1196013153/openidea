/** VCS actions (ids match keymaps/intellij-macos.ts where bound). */
import { registerActions, type Action } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { activeEditor, editorsFor } from "@/editor/api";
import { Menu, type MenuItem } from "@/ui";
import { editorService, maybeEditorService, notifications, toolWindowService } from "@/workbench/contributions";
import { annotationsShown, toggleAnnotations } from "./blame";
import { showBranchesPopup } from "./BranchWidget";
import { checkoutRevision, newBranch } from "./branchOps";
import { addToVcs, isNestedRepoEntry, rollbackCandidates, showRollbackDialog, stashChanges } from "./changeOps";
import { useCommit } from "./commitStore";
import { gotoConflict, resolveAtCaret, showConflictsDialog } from "./conflictsUi";
import { focusedDiffNavigator } from "./diffNavigator";
import { openDiff, workingDiffData } from "./diffInput";
import { openDialog } from "./dialogs";
import { gotoChange } from "./gutter";
import { openLocalHistory } from "./localHistoryKind";
import { revealCommit, setLogFilters, useGitLog, emptyFilters } from "./logStore";
import { allRepos, runRemote } from "./ops";
import { showPushDialog, showUpdateDialog, type PushTarget } from "./remoteUi";
import { chooseRevision } from "./RevisionChooser";
import { showCloneDialog } from "./clone";
import { refreshNow, repoName } from "./store";

const VCS = "vcsAvailable";

function argPath(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "path" in arg && typeof (arg as { path: unknown }).path === "string")
    return (arg as { path: string }).path;
  return undefined;
}

function argPaths(arg: unknown): string[] | undefined {
  if (Array.isArray(arg)) return arg.filter((x): x is string => typeof x === "string");
  const p = argPath(arg);
  return p ? [p] : undefined;
}

const commitWindowFocused = () => getContext().activeToolWindow === "commit";

/** Files the current context refers to: argument, commit view selection, or the active file. */
function contextPaths(arg: unknown): string[] {
  const explicit = argPaths(arg);
  if (explicit?.length) return explicit;
  const sel = useCommit.getState().selection;
  if (commitWindowFocused() && sel.length) return sel;
  const active = maybeEditorService()?.activePath();
  return active ? [active] : [];
}

function showCommitWindow(tab: "changes" | "stashes" = "changes") {
  useCommit.setState((s) => ({ tab, focusTick: tab === "changes" ? s.focusTick + 1 : s.focusTick }));
  toolWindowService().show("commit", true);
}

function showGitWindow() {
  toolWindowService().show("git", true);
}

async function annotate(arg: unknown) {
  const path = argPath(arg);
  let handle = activeEditor();
  if (path && handle?.ctx.path !== path) {
    await editorService().openFile(path, { focus: true });
    handle = editorsFor(path)[0] ?? activeEditor();
  }
  if (!handle) {
    notifications().notify({ group: "vcs", level: "info", title: "Open a file to annotate it" });
    return;
  }
  await toggleAnnotations(handle.view, handle.ctx.path);
}

const OPERATIONS: MenuItem[] = [
  { kind: "header", label: "Git" },
  { kind: "action", action: "vcs.commit" },
  { kind: "action", action: "vcs.push" },
  { kind: "action", action: "vcs.update" },
  { kind: "action", action: "vcs.fetch" },
  { kind: "separator" },
  { kind: "action", action: "vcs.rollback" },
  { kind: "action", action: "vcs.showDiff" },
  { kind: "action", action: "vcs.compareWithBranch" },
  { kind: "action", action: "vcs.addToVcs" },
  { kind: "separator" },
  { kind: "action", action: "vcs.annotate" },
  { kind: "action", action: "vcs.showHistory" },
  { kind: "action", action: "vcs.localHistory" },
  { kind: "separator" },
  { kind: "action", action: "vcs.branches" },
  { kind: "action", action: "vcs.newBranch" },
  { kind: "action", action: "vcs.stash" },
  { kind: "action", action: "vcs.unstash" },
  { kind: "action", action: "vcs.resolveConflicts" },
];

function showOperations() {
  openDialog((close) => (
    <Menu
      open
      onClose={close}
      anchor={{ x: Math.max(16, window.innerWidth / 2 - 140), y: Math.round(window.innerHeight * 0.18) }}
      items={OPERATIONS}
      aria-label="VCS Operations"
    />
  ));
}

export function registerVcsActions(): () => void {
  const actions: Action[] = [
    {
      id: "vcs.operations",
      title: "VCS Operations…",
      category: "Git",
      icon: "branch",
      when: "projectOpen",
      keywords: ["git", "quick list"],
      run: showOperations,
    },
    {
      id: "vcs.commit",
      title: "Commit…",
      category: "Git",
      icon: "commit",
      when: VCS,
      run: () => showCommitWindow(),
    },
    {
      id: "vcs.clone",
      title: "Get from Version Control…",
      category: "Git",
      icon: "git-pull",
      keywords: ["clone", "checkout", "git"],
      run: (c) => showCloneDialog(typeof c.arg === "string" ? c.arg : ""),
    },
    { id: "vcs.push", title: "Push…", category: "Git", icon: "git-push", when: VCS, run: ({ arg }) => void showPushDialog(arg && typeof arg === "object" ? (arg as PushTarget) : {}) },
    {
      id: "vcs.update",
      title: "Update Project…",
      category: "Git",
      icon: "git-pull",
      when: VCS,
      keywords: ["pull"],
      run: showUpdateDialog,
    },
    {
      id: "vcs.fetch",
      title: "Fetch",
      category: "Git",
      icon: "git-fetch",
      when: VCS,
      run: () => void runRemote({ op: "fetch" }, undefined, allRepos()),
    },
    {
      id: "vcs.refresh",
      title: "Refresh VCS Status",
      category: "Git",
      icon: "refresh",
      when: VCS,
      run: () => void refreshNow(),
    },
    {
      id: "vcs.rollback",
      title: "Rollback…",
      category: "Git",
      icon: "undo",
      when: VCS,
      keywords: ["revert", "discard"],
      run: ({ arg }) => {
        const explicit = argPaths(arg);
        const sel = useCommit.getState().selection;
        const paths = explicit?.length ? explicit : commitWindowFocused() && sel.length ? sel : undefined;
        if (paths) {
          const candidates = rollbackCandidates(paths);
          const submodule = paths.find((p) => isNestedRepoEntry(p));
          if (!candidates.length && submodule)
            return notifications().notify({
              group: "vcs",
              level: "info",
              title: "Submodule changes cannot be rolled back here",
              body: `${repoName(submodule)} points to another commit. Check out the recorded commit in the submodule (git submodule update) to revert it.`,
            });
          return showRollbackDialog(candidates);
        }
        const active = maybeEditorService()?.activePath();
        const activeChanged = active ? rollbackCandidates([active]) : [];
        showRollbackDialog(activeChanged.length ? activeChanged : rollbackCandidates());
      },
    },
    {
      id: "vcs.showDiff",
      title: "Show Diff",
      category: "Git",
      icon: "diff",
      when: VCS,
      // ⌘D duplicates the line inside a text editor; Git › Show Diff still works there.
      keyWhen: "!editorTextFocus",
      run: async ({ arg }) => {
        const line =
          arg && typeof arg === "object" && "line" in arg ? Number((arg as { line: unknown }).line) : undefined;
        const paths = contextPaths(arg).filter((p) => !p.endsWith("/"));
        if (!paths.length) {
          notifications().notify({ group: "vcs", level: "info", title: "Select a changed file to show its diff" });
          return;
        }
        for (const p of paths.slice(0, 5)) await openDiff(workingDiffData(p, line), { preview: paths.length === 1 });
      },
    },
    {
      id: "vcs.compareWithBranch",
      title: "Compare with Branch or Revision…",
      category: "Git",
      icon: "diff",
      when: VCS,
      run: async ({ arg }) => {
        const path = contextPaths(arg)[0];
        if (!path) {
          notifications().notify({ group: "vcs", level: "info", title: "Open or select a file to compare" });
          return;
        }
        const rev = await chooseRevision("Compare with Branch or Revision");
        if (!rev) return;
        await openDiff({ path, left: { type: "rev", rev, label: rev }, right: { type: "worktree" } });
      },
    },
    {
      id: "vcs.nextChange",
      title: "Next Change",
      category: "Git",
      icon: "arrow-down",
      when: VCS,
      run: () => {
        const diff = focusedDiffNavigator();
        if (diff) return diff.next();
        const ed = activeEditor();
        if (ed) gotoChange(ed.view, 1);
      },
    },
    {
      id: "vcs.prevChange",
      title: "Previous Change",
      category: "Git",
      icon: "arrow-up",
      when: VCS,
      run: () => {
        const diff = focusedDiffNavigator();
        if (diff) return diff.prev();
        const ed = activeEditor();
        if (ed) gotoChange(ed.view, -1);
      },
    },
    {
      id: "vcs.annotate",
      title: "Annotate with Git Blame",
      category: "Git",
      icon: "history",
      when: VCS,
      keywords: ["blame", "annotations"],
      toggled: () => {
        const ed = activeEditor();
        return !!ed && annotationsShown(ed.view);
      },
      run: ({ arg }) => annotate(arg),
    },
    {
      id: "vcs.localHistory",
      title: "Show Local History",
      category: "Git",
      icon: "clock",
      when: "projectOpen",
      run: ({ arg }) => {
        const path = argPath(arg) ?? maybeEditorService()?.activePath();
        if (!path) {
          notifications().notify({ group: "vcs", level: "info", title: "Open a file to show its local history" });
          return;
        }
        openLocalHistory(path);
      },
    },
    {
      id: "vcs.branches",
      title: "Branches…",
      category: "Git",
      icon: "branch",
      when: VCS,
      keywords: ["checkout", "git branches"],
      run: showBranchesPopup,
    },
    {
      id: "vcs.newBranch",
      title: "New Branch…",
      category: "Git",
      icon: "plus",
      when: VCS,
      run: () => void newBranch(),
    },
    {
      id: "vcs.checkoutRevision",
      title: "Checkout Tag or Revision…",
      category: "Git",
      when: VCS,
      run: () => void checkoutRevision(),
    },
    {
      id: "vcs.showLog",
      title: "Show Git Log",
      category: "Git",
      icon: "branch",
      when: VCS,
      run: ({ arg }) => {
        const a = (arg ?? {}) as { branch?: string; path?: string };
        useGitLog.setState({ tab: "log" });
        setLogFilters({ ...emptyFilters(), branch: a.branch ?? null, path: a.path ?? null });
        showGitWindow();
      },
    },
    {
      id: "vcs.showHistory",
      title: "Show History for File",
      category: "Git",
      icon: "history",
      when: VCS,
      run: ({ arg }) => {
        const path = contextPaths(arg)[0];
        if (!path) return;
        useGitLog.setState({ tab: "log" });
        setLogFilters({ ...emptyFilters(), path });
        showGitWindow();
      },
    },
    {
      id: "vcs.showCommit",
      title: "Show Commit in Git Log",
      category: "Git",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        if (typeof arg !== "string") return;
        showGitWindow();
        void revealCommit(arg);
      },
    },
    {
      id: "vcs.addToVcs",
      title: "Add to VCS",
      category: "Git",
      icon: "plus",
      when: VCS,
      keywords: ["git add", "stage"],
      run: ({ arg }) => {
        return addToVcs(contextPaths(arg));
      },
    },
    {
      id: "vcs.stash",
      title: "Stash Changes…",
      category: "Git",
      icon: "stash",
      when: VCS,
      run: () => void stashChanges(),
    },
    {
      id: "vcs.unstash",
      title: "Unstash Changes…",
      category: "Git",
      when: VCS,
      run: () => showCommitWindow("stashes"),
    },
    {
      id: "vcs.resolveConflicts",
      title: "Resolve Conflicts…",
      category: "Git",
      when: VCS,
      keywords: ["merge"],
      run: showConflictsDialog,
    },
    {
      id: "vcs.acceptYours",
      title: "Accept Yours (Conflict at Caret)",
      category: "Git",
      when: "editorTextFocus",
      run: () => void resolveAtCaret("ours"),
    },
    {
      id: "vcs.acceptTheirs",
      title: "Accept Theirs (Conflict at Caret)",
      category: "Git",
      when: "editorTextFocus",
      run: () => void resolveAtCaret("theirs"),
    },
    {
      id: "vcs.acceptBoth",
      title: "Accept Both (Conflict at Caret)",
      category: "Git",
      when: "editorTextFocus",
      run: () => void resolveAtCaret("both"),
    },
    {
      id: "vcs.nextConflict",
      title: "Next Conflict Marker",
      category: "Git",
      when: "editorTextFocus",
      run: () => void gotoConflict(1),
    },
    {
      id: "vcs.prevConflict",
      title: "Previous Conflict Marker",
      category: "Git",
      when: "editorTextFocus",
      run: () => void gotoConflict(-1),
    },
  ];
  return registerActions(actions);
}
