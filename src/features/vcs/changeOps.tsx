/** Local change operations: commit, rollback, add, stash. */
import { useState } from "react";
import type { FileStatus } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Dialog, Icon, fileIconName } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { commitRepos, groupOf, planCommit, renamedFromPath } from "./changes";
import { useChangelists, withListDefaults } from "./changelists";
import { runCommitChecks } from "./commitChecks";
import { rememberMessage, useCommit } from "./commitStore";
import { confirmDialog, openDialog, promptText } from "./dialogs";
import { KIND_COLOR, baseName, dirName, effectiveKind, relTo, stripSlash } from "./model";
import { logConsole, runOp, saveAll } from "./ops";
import { currentRepo, loadStashes, refreshNow, useVcs } from "./store";
import styles from "./common.module.css";

export function firstLine(message: string): string {
  return message.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/** Stages the included changes and commits them. Returns the new commit id. */
export async function commitChanges(): Promise<string | undefined> {
  const { message, amend, signOff, author, runHooks } = useCommit.getState();
  if (!message.trim() && !amend) {
    notifications().notify({ group: "vcs", level: "warning", title: "Commit message is empty" });
    return undefined;
  }
  await saveAll();
  await refreshNow();
  const status = useVcs.getState().status;
  const checks = withListDefaults(status, useVcs.getState().root ?? "", useChangelists.getState().state, useCommit.getState().checks);
  const plan = planCommit(status, checks);
  // Concluding a merge needs no further changes (e.g. every conflict resolved as "yours").
  const merging = useVcs.getState().branch?.operation === "merge";
  if (!plan.included.length && !amend && !merging) {
    notifications().notify({ group: "vcs", level: "warning", title: "No changes selected for commit" });
    return undefined;
  }
  const unresolved = plan.included.filter((f) => effectiveKind(f) === "conflicted");
  if (unresolved.length) {
    notifications().notify({
      group: "vcs",
      level: "warning",
      title: "Resolve merge conflicts before committing",
      body: unresolved.map((f) => baseName(f.path)).join(", "),
    });
    return undefined;
  }
  const candidates = plan.included.map((f) => ({ path: stripSlash(f.path), exists: effectiveKind(f) !== "deleted" }));
  if (!(await runCommitChecks(candidates, amend))) return undefined;
  // Like IDEA, every repository with included changes gets a commit with the same message.
  const repos = commitRepos(plan.included, useVcs.getState().roots, currentRepo());
  const id = await runOp(
    amend ? "Amend commit" : "Commit",
    async () => {
      if (plan.unstage.length) await call(commands.vcsUnstage(plan.unstage));
      if (plan.stage.length) await call(commands.vcsStage(plan.stage));
      const options = { amend, signOff, author: author.trim() || null, runHooks };
      let id = "";
      for (const repo of repos) id = await call(commands.vcsCommit(repo, message.trim(), options));
      return id;
    },
    {
      success: () => {
        const n = plan.included.length;
        const summary = firstLine(message);
        const where = repos.length > 1 ? ` in ${repos.length} repositories` : "";
        return `${n} file${n === 1 ? "" : "s"} ${amend ? "amended" : "committed"}${where}${summary ? `: ${summary}` : ""}`;
      },
    },
  );
  if (id !== undefined) {
    rememberMessage(message);
    useCommit.setState({ message: "", amend: false, checks: new Map() });
  }
  return id;
}

/** Files the Rollback action applies to by default. */
export function rollbackCandidates(paths?: readonly string[]): FileStatus[] {
  const status = useVcs.getState().status.filter((f) => {
    const g = groupOf(f);
    return g === "changes" || g === "conflicts";
  });
  if (!paths?.length) return status;
  const set = new Set(paths.map(stripSlash));
  const picked = status.filter((f) => {
    const p = stripSlash(f.path);
    if (set.has(p)) return true;
    for (const s of set) if (p.startsWith(s + "/")) return true;
    return false;
  });
  return picked;
}

/**
 * Paths to unstage and to discard for Rollback. A staged rename rolls back both
 * sides (the old file is restored); added files become unversioned after
 * unstaging and are only deleted when asked to.
 */
export function rollbackPlan(files: readonly FileStatus[], deleteAdded: boolean): { unstage: string[]; discard: string[] } {
  const unstage: string[] = [];
  const discard: string[] = [];
  for (const f of files) {
    const path = stripSlash(f.path);
    const from = f.staged === "renamed" ? renamedFromPath(f) : null;
    if (f.staged) unstage.push(path, ...(from ? [from] : []));
    if (from) discard.push(path, from);
    else if (f.staged !== "added" || deleteAdded) discard.push(path);
  }
  return { unstage, discard };
}

export function showRollbackDialog(files: FileStatus[]) {
  if (!files.length) {
    notifications().notify({ group: "vcs", level: "info", title: "No changes to roll back" });
    return;
  }
  openDialog((close) => <RollbackDialog files={files} onClose={close} />);
}

function RollbackDialog({ files, onClose }: { files: FileStatus[]; onClose: () => void }) {
  const root = useVcs((s) => s.root) ?? "";
  const [selected, setSelected] = useState(() => new Set(files.map((f) => f.path)));
  const [deleteAdded, setDeleteAdded] = useState(false);
  const hasAdded = files.some((f) => f.staged === "added");
  const run = async () => {
    const chosen = files.filter((f) => selected.has(f.path));
    onClose();
    if (!chosen.length) return;
    await saveAll();
    const { unstage, discard } = rollbackPlan(chosen, deleteAdded);
    await runOp(
      "Rollback",
      async () => {
        if (unstage.length) await call(commands.vcsUnstage(unstage));
        if (discard.length) await call(commands.vcsDiscard(discard));
      },
      { success: `Rolled back ${chosen.length} file${chosen.length === 1 ? "" : "s"}` },
    );
  };
  return (
    <Dialog
      open
      title="Rollback Changes"
      onClose={onClose}
      width={520}
      footerStart={
        hasAdded && (
          <Checkbox checked={deleteAdded} onChange={setDeleteAdded} label="Delete local copies of added files" />
        )
      }
      buttons={[
        { label: "Rollback", role: "default", autoFocus: true, disabled: !selected.size, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.section}>
        {selected.size} of {files.length} file{files.length === 1 ? "" : "s"} will be reverted to their last committed
        state. Uncommitted changes are lost.
      </div>
      <div className={styles.fileList} role="group" aria-label="Files to roll back">
        {files.map((f) => {
          const kind = effectiveKind(f) ?? "modified";
          return (
            <div key={f.path} className={styles.fileRow}>
              <Checkbox
                aria-label={`Include ${baseName(f.path)}`}
                checked={selected.has(f.path)}
                onChange={(v) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (v) n.add(f.path);
                    else n.delete(f.path);
                    return n;
                  })
                }
              />
              <Icon name={fileIconName(baseName(f.path))} size={14} />
              <span className={styles.fileName} style={{ color: KIND_COLOR[kind] }}>
                {baseName(f.path)}
              </span>
              <span className={styles.fileDir}>{dirName(relTo(root, stripSlash(f.path)))}</span>
            </div>
          );
        })}
      </div>
      <div style={{ height: 12 }} />
    </Dialog>
  );
}

/**
 * Add to VCS targets: the unversioned files among `paths` or below a selected
 * directory. Tracked changes inside a directory are not staged (unlike `git add -A dir`).
 */
export function addToVcsTargets(paths: readonly string[], status: readonly FileStatus[]): string[] {
  const untracked = status.filter((f) => effectiveKind(f) === "untracked").map((f) => stripSlash(f.path));
  const out = new Set<string>();
  for (const raw of paths) {
    const p = stripSlash(raw);
    for (const u of untracked) if (u === p || u.startsWith(`${p}/`)) out.add(u);
  }
  return [...out];
}

/** Stages unversioned files (`git add`). */
export async function addToVcs(paths: readonly string[]) {
  const targets = addToVcsTargets(paths, useVcs.getState().status);
  if (!targets.length) {
    notifications().notify({ group: "vcs", level: "info", title: "Nothing to add: the files are already under version control" });
    return;
  }
  await runOp(`Add ${targets.length} file${targets.length === 1 ? "" : "s"} to Git`, () =>
    call(commands.vcsStage(targets.map(stripSlash))),
  );
}

export async function stashChanges() {
  const r = await promptText({
    title: "Stash Changes",
    label: "Message:",
    placeholder: "WIP",
    okLabel: "Create Stash",
    validate: () => null,
    checkbox: { label: "Include untracked files", initial: false },
  });
  if (!r) return;
  await saveAll();
  await runOp("Stash changes", () => call(commands.vcsStashPush(currentRepo(), r.value || null, r.checked)), {
    success: "Changes stashed",
  });
  void loadStashes().catch(() => undefined);
}

export async function applyStash(index: number, pop: boolean) {
  await saveAll();
  await runOp(`${pop ? "Pop" : "Apply"} stash@{${index}}`, () => call(commands.vcsStashApply(currentRepo(), index, pop)), {
    success: pop ? `Unstashed stash@{${index}}` : `Applied stash@{${index}}`,
  });
  void loadStashes().catch((e) => logConsole("err", String(e)));
}

export async function dropStash(index: number, message: string) {
  const ok = await confirmDialog({
    title: "Drop Stash",
    message: `Drop stash@{${index}}${message ? ` “${message}”` : ""}? This cannot be undone.`,
    okLabel: "Drop",
    danger: true,
  });
  if (!ok) return;
  await runOp(`Drop stash@{${index}}`, () => call(commands.vcsStashDrop(currentRepo(), index)), {
    success: `Dropped stash@{${index}}`,
  });
  void loadStashes().catch((e) => logConsole("err", String(e)));
}
