/** Update Project and Push dialogs. */
import { useEffect, useState } from "react";
import type { Commit, PushTags, RemoteOp } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { Checkbox, Dialog, List, Select, Spinner } from "@/ui";
import { openDialog } from "./dialogs";
import { formatTime } from "./model";
import { lastRemoteFailure, runRemote, saveAll } from "./ops";
import { refreshNow, useVcs } from "./store";
import styles from "./common.module.css";

export function showUpdateDialog() {
  openDialog((close) => <UpdateDialog onClose={close} />);
}

function UpdateDialog({ onClose }: { onClose: () => void }) {
  const branch = useVcs((s) => s.branch);
  // Default from Settings › Version Control › Git › Update method.
  const [rebase, setRebase] = useState(() => workflowSettings().vcs.git.updateMethod === "rebase");
  const run = async () => {
    onClose();
    await saveAll();
    await runRemote({ op: "pull", rebase }, branch?.upstream ? `${branch.head} ← ${branch.upstream}` : undefined);
  };
  return (
    <Dialog
      open
      title="Update Project"
      onClose={onClose}
      width={420}
      buttons={[
        { label: "OK", role: "default", autoFocus: true, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form} role="radiogroup" aria-label="Update type">
        <div className={styles.hint}>
          {branch?.upstream
            ? `Update ${branch.head ?? "HEAD"} from ${branch.upstream}${branch.behind ? ` (${branch.behind} incoming)` : ""}`
            : "The current branch has no tracked branch; git pull may fail."}
        </div>
        <div className={styles.fieldLabel}>Update type:</div>
        <label className={styles.radioRow}>
          <input type="radio" name="update" checked={!rebase} onChange={() => setRebase(false)} />
          <span className={styles.radioText}>
            Merge incoming changes into the current branch
            <span className={styles.hint}>git pull --no-rebase --ff</span>
          </span>
        </label>
        <label className={styles.radioRow}>
          <input type="radio" name="update" checked={rebase} onChange={() => setRebase(true)} />
          <span className={styles.radioText}>
            Rebase the current branch on top of incoming changes
            <span className={styles.hint}>git pull --rebase</span>
          </span>
        </label>
        <div className={styles.hint}>Uncommitted changes are stashed before the update and restored afterwards.</div>
      </div>
    </Dialog>
  );
}

const logOf = (branch: string, limit: number, range: string | null = null) =>
  call(commands.vcsLog({ branch, path: null, author: null, text: null, range, skip: 0, limit }));

/** Outgoing commits of the current branch: `@{u}..HEAD`, or recent HEAD history without an upstream. */
export function outgoingQuery(upstream: string | null): { branch: string; range: string | null; limit: number } {
  return upstream ? { branch: "HEAD", range: "@{u}..HEAD", limit: 1000 } : { branch: "HEAD", range: null, limit: 50 };
}

export interface PushTarget {
  /** Local branch to push (default: the current one). */
  branch?: string;
  /** Push only up to this commit of the branch (Push All up to Here). */
  revision?: Commit;
}

export async function showPushDialog(target: PushTarget = {}) {
  await refreshNow();
  openDialog((close) => <PushDialog target={target} onClose={close} />);
}

function PushDialog({ target: pushTarget, onClose }: { target: PushTarget; onClose: () => void }) {
  const branch = useVcs((s) => s.branch);
  const branches = useVcs((s) => s.branches);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const current = branch?.head ?? null;
  const head = pushTarget.branch ?? current;
  // Another branch, or a partial push: `git push <remote> <src>:<dst>` instead of the plain push.
  const explicit = head !== current || !!pushTarget.revision;
  const upstream = explicit ? (branches.find((b) => !b.remote && b.name === head)?.upstream ?? null) : (branch?.upstream ?? null);
  const revision = pushTarget.revision?.id ?? null;
  const [setUpstream, setSetUpstream] = useState(!upstream);
  const [pushTags, setPushTags] = useState(false);
  const [tagsMode, setTagsMode] = useState<PushTags>("all");

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!head) return [];
      if (!explicit) {
        const q = outgoingQuery(upstream);
        return logOf(q.branch, q.limit, q.range);
      }
      const tip = revision ?? head;
      return upstream ? logOf(tip, 1000, `${upstream}..${tip}`) : logOf(tip, 50);
    })()
      .then((c) => alive && setCommits(c))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [head, upstream, explicit, revision]);

  const target = upstream ? upstream.slice(upstream.indexOf("/") + 1) : head;
  const protectedTarget = !!target && isProtectedBranch(target);
  const push = async () => {
    onClose();
    if (explicit && head) {
      await runRemote(
        { op: "pushBranch", branch: head, revision, force_with_lease: force && !protectedTarget },
        `${revision ? `${head} up to ${revision.slice(0, 8)}` : head} → ${upstream ?? "new remote branch"}`,
      );
      return;
    }
    await pushWithAutoUpdate(
      {
        op: "push",
        force_with_lease: force && !protectedTarget,
        set_upstream: setUpstream || !upstream,
        tags: pushTags ? tagsMode : null,
      },
      upstream ? `${head} → ${upstream}` : `${head} → new remote branch`,
    );
  };

  return (
    <Dialog
      open
      title={head ? `Push Commits to ${upstream ?? "remote"}` : "Push"}
      onClose={onClose}
      width={620}
      footerStart={
        <>
          <span title={protectedTarget ? `Force push to protected branch '${target}' is prohibited` : undefined}>
            <Checkbox
              checked={force && !protectedTarget}
              disabled={protectedTarget}
              onChange={setForce}
              label="Force (with lease)"
            />
          </span>
          {!explicit && (
            <>
              <Checkbox
                checked={setUpstream || !upstream}
                disabled={!upstream}
                onChange={setSetUpstream}
                label="Set upstream"
              />
              <Checkbox checked={pushTags} onChange={setPushTags} label="Push tags:" />
              <Select<PushTags>
                value={tagsMode}
                disabled={!pushTags}
                aria-label="Tags to push"
                onChange={setTagsMode}
                options={[
                  { value: "all", label: "All" },
                  { value: "currentBranch", label: "Current Branch" },
                ]}
              />
            </>
          )}
        </>
      }
      buttons={[
        {
          label: force && !protectedTarget ? "Force Push" : "Push",
          role: "default",
          autoFocus: true,
          disabled: !head,
          onClick: () => void push(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.section}>
        {!head
          ? "HEAD is detached; check out a branch to push."
          : upstream
            ? `${head}${revision ? ` up to ${revision.slice(0, 8)}` : ""} → ${upstream}`
            : revision
              ? `${head} has no upstream: commits up to ${revision.slice(0, 8)} will be pushed as a new branch.`
              : `${head} has no upstream: it will be pushed as a new branch and tracked.`}
      </div>
      <div style={{ height: 300, display: "flex", flexDirection: "column", padding: "0 14px 14px" }}>
        {error ? (
          <div className={styles.error}>{error}</div>
        ) : !commits ? (
          <div className={styles.empty}>
            <Spinner size={14} />
          </div>
        ) : (
          <List
            items={commits}
            getKey={(c) => c.id}
            rowHeight={22}
            aria-label="Outgoing commits"
            className={styles.boxList}
            empty={<span>{upstream ? "Everything is up to date" : "No commits"}</span>}
            renderItem={(c) => (
              <span className={styles.commitRow} style={{ flex: 1, padding: 0 }}>
                <span className={styles.commitHash}>{c.shortId}</span>
                <span className={styles.commitSubject}>{c.summary}</span>
                <span className={styles.commitMeta}>{c.author}</span>
                <span className={styles.commitMeta}>{formatTime(c.timeMs)}</span>
              </span>
            )}
          />
        )}
      </div>
    </Dialog>
  );
}

/** Settings › Git › Protected branches: `;`/`,`-separated globs (`*`, `?`). */
export function isProtectedBranch(branch: string, patterns = workflowSettings().vcs.git.protectedBranches): boolean {
  return patterns
    .split(/[;,\s]+/)
    .filter(Boolean)
    .some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(branch));
}

/** Rejected because the remote has commits we don't (non-fast-forward). */
export function isPushRejected(message: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|updates were rejected/i.test(message);
}

/**
 * Pushes; when the push is rejected, either updates (pull with the configured
 * update method) and pushes again ("Auto-update if push of the current branch
 * was rejected") or offers to.
 */
export async function pushWithAutoUpdate(op: Extract<RemoteOp, { op: "push" }>, detail: string): Promise<boolean> {
  if (await runRemote(op, detail)) return true;
  const error = lastRemoteFailure();
  if (!error || op.force_with_lease || !isPushRejected(error)) return false;
  const git = workflowSettings().vcs.git;
  const updateAndPush = async () => {
    await saveAll();
    if (!(await runRemote({ op: "pull", rebase: git.updateMethod === "rebase" }, "updating after rejected push"))) return false;
    return runRemote(op, detail);
  };
  if (git.autoUpdateOnPushRejected) return updateAndPush();
  notifications().notify({
    level: "error",
    key: "vcs.remote",
    title: "Push rejected",
    body: "The remote contains commits that are not in your branch. Update the branch, then push again.",
    actions: [
      { label: git.updateMethod === "rebase" ? "Rebase and Push" : "Merge and Push", run: () => void updateAndPush() },
    ],
  });
  return false;
}
