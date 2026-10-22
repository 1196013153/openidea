/** Branch operations (checkout, create, merge, rebase, update, delete) with recents and favorites. */
import { create } from "zustand";
import type { Branch } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { isFavoriteBranch, pushRecent, shortRemoteName } from "./branches";
import { confirmDialog, promptText } from "./dialogs";
import { runOp, runRemote, saveAll } from "./ops";
import { conflictedFiles, refreshNow, useVcs } from "./store";

const recentKey = () => `openidea.vcs.recentBranches:${useVcs.getState().root ?? ""}`;

export function recentBranches(): string[] {
  try {
    const raw = localStorage.getItem(recentKey());
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberBranch(name: string | null | undefined) {
  if (!name) return;
  try {
    localStorage.setItem(recentKey(), JSON.stringify(pushRecent(recentBranches(), name)));
  } catch {
    // Storage unavailable: recents are a convenience only.
  }
}

/** Valid-enough git ref name check (mirrors `git check-ref-format` basics). */
export function validateBranchName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Branch name must not be empty";
  if (/[\s~^:?*[\\\p{Cc}]/u.test(n)) return "Branch name contains invalid characters";
  if (n.startsWith("-") || n.startsWith("/") || n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock"))
    return "Invalid branch name";
  if (n.includes("..") || n.includes("//") || n.includes("@{") || n === "@") return "Invalid branch name";
  const exists = useVcs.getState().branches.some((b) => !b.remote && b.name === n);
  if (exists) return `Branch '${n}' already exists`;
  return null;
}

export async function checkoutBranch(name: string) {
  const previous = useVcs.getState().branch?.head;
  await saveAll();
  const ok = await runOp(`Checkout ${name}`, () => call(commands.vcsCheckout(name, false)), {
    success: () => `Checked out ${useVcs.getState().branch?.head ?? name}`,
  });
  if (ok !== undefined) {
    rememberBranch(previous);
    await refreshNow();
    rememberBranch(useVcs.getState().branch?.head);
  }
}

/** New Branch: creates a branch from HEAD (or `from`) and, by default, checks it out. */
export async function newBranch(from?: string) {
  const suggestion = from ? (from.includes("/") ? shortRemoteName(from) : `${from}-copy`) : "";
  const r = await promptText({
    title: from ? `Create New Branch from ${from}` : "Create New Branch",
    label: "New branch name:",
    initial: from && from.includes("/") && !validateBranchName(suggestion) ? suggestion : "",
    mono: true,
    okLabel: "Create",
    validate: validateBranchName,
    checkbox: { label: "Checkout branch", initial: true },
  });
  if (!r) return;
  const checkout = r.checked;
  const previous = useVcs.getState().branch?.head;
  if (checkout) await saveAll();
  const ok = await runOp(`Create branch ${r.value}`, () => call(commands.vcsCreateBranch(r.value, from ?? null, checkout)), {
    success: checkout ? `Created and checked out ${r.value}` : `Created branch ${r.value}`,
  });
  if (ok !== undefined && checkout) {
    rememberBranch(previous);
    rememberBranch(r.value);
  }
}

export async function checkoutRevision() {
  const r = await promptText({
    title: "Checkout Tag or Revision",
    label: "Enter a tag, branch or commit hash:",
    mono: true,
    okLabel: "Checkout",
    validate: (v) => (v.trim() ? null : "Enter a revision"),
  });
  if (!r) return;
  await saveAll();
  await runOp(`Checkout ${r.value}`, () => call(commands.vcsCheckout(r.value, false)), {
    success: `Checked out ${r.value}`,
  });
}

function conflictActions(message: string) {
  return conflictedFiles().length || /conflict/i.test(message)
    ? [{ label: "Resolve Conflicts…", run: () => void executeAction("vcs.resolveConflicts") }]
    : [];
}

/**
 * A merge / rebase that stopped on conflicts isn't an error in IDEA: it opens
 * the Conflicts dialog instead of an error balloon.
 */
async function openConflictsInstead(): Promise<boolean> {
  await refreshNow();
  if (!conflictedFiles().length) return false;
  void executeAction("vcs.resolveConflicts");
  return true;
}

export async function mergeIntoCurrent(branch: string) {
  const current = useVcs.getState().branch?.head ?? "HEAD";
  await saveAll();
  await runOp(`Merge ${branch} into ${current}`, () => call(commands.vcsMerge(branch)), {
    success: `Merged ${branch} into ${current}`,
    errorActions: conflictActions,
    onError: openConflictsInstead,
  });
}

export async function rebaseOnto(branch: string) {
  const current = useVcs.getState().branch?.head ?? "HEAD";
  await saveAll();
  await runOp(`Rebase ${current} onto ${branch}`, () => call(commands.vcsRebase(branch)), {
    success: `Rebased ${current} onto ${branch}`,
    errorActions: conflictActions,
    onError: openConflictsInstead,
  });
}

export async function renameBranch(name: string) {
  const r = await promptText({
    title: `Rename Branch ${name}`,
    label: "New branch name:",
    initial: name,
    mono: true,
    okLabel: "Rename",
    validate: (v) => (v.trim() === name ? "Enter a new name" : validateBranchName(v)),
  });
  if (!r) return;
  const to = r.value.trim();
  const ok = await runOp(`Rename branch ${name}`, () => call(commands.vcsRenameBranch(name, to)), {
    success: `Renamed branch ${name} to ${to}`,
  });
  if (ok !== undefined) {
    try {
      localStorage.setItem(recentKey(), JSON.stringify(recentBranches().map((b) => (b === name ? to : b))));
    } catch {
      // Recents are best effort.
    }
  }
}

export async function deleteBranch(name: string) {
  const ok = await confirmDialog({
    title: "Delete Branch",
    message: `Delete local branch '${name}'?`,
    okLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  await runOp(`Delete branch ${name}`, () => call(commands.vcsDeleteBranch(name, false)), {
    success: `Deleted branch ${name}`,
    errorActions: (m) =>
      /not fully merged/i.test(m)
        ? [
            {
              label: "Force Delete",
              run: () =>
                void runOp(`Force delete ${name}`, () => call(commands.vcsDeleteBranch(name, true)), {
                  success: `Deleted branch ${name}`,
                }),
            },
          ]
        : [],
  });
}

/** Deletes a branch on its remote (`git push <remote> --delete <name>`); `name` is e.g. `origin/feature`. */
export async function deleteRemoteBranch(name: string) {
  const ok = await confirmDialog({
    title: "Delete Remote Branch",
    message: `Delete branch '${shortRemoteName(name)}' on the remote? The remote-tracking branch '${name}' is removed as well.`,
    okLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  await runRemote({ op: "deleteBranch", branch: name }, name);
}

/** Checkout and Rebase onto Current: checks out `name`, then rebases it onto the branch that was current. */
export async function checkoutAndRebase(name: string) {
  const current = useVcs.getState().branch?.head;
  if (!current) return;
  await saveAll();
  const ok = await runOp(`Checkout ${name}`, () => call(commands.vcsCheckout(name, false)));
  if (ok === undefined) return;
  rememberBranch(current);
  rememberBranch(name);
  await refreshNow();
  await rebaseOnto(current);
}

/** Update for a branch other than the current one: fast-forwards it to its upstream. */
export async function updateBranch(name: string) {
  const b = useVcs.getState().branches.find((x) => !x.remote && x.name === name);
  if (b?.current) return void executeAction("vcs.update");
  if (!b?.upstream) {
    notifications().notify({ group: "vcs", level: "warning", title: `Branch '${name}' has no tracked branch` });
    return;
  }
  await runRemote({ op: "updateBranch", branch: name }, `${name} ← ${b.upstream}`);
}

// --- favorites ---------------------------------------------------------------

const favoritesKey = () => `openidea.vcs.favoriteBranches:${useVcs.getState().root ?? ""}`;

/** The user's favorite branches for the open repository; `null` = defaults (main / master). */
export const useFavoriteBranches = create<{ key: string; names: string[] | null }>(() => ({ key: "", names: null }));

export function loadFavoriteBranches() {
  const key = favoritesKey();
  if (useFavoriteBranches.getState().key === key) return;
  let names: string[] | null = null;
  try {
    const raw = localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v)) names = v.filter((x): x is string => typeof x === "string");
  } catch {
    // Storage unavailable: defaults.
  }
  useFavoriteBranches.setState({ key, names });
}

export function toggleFavoriteBranch(b: Branch) {
  loadFavoriteBranches();
  const stored = useFavoriteBranches.getState().names;
  // First edit: start from the defaults that are currently shown.
  const base = stored ?? useVcs.getState().branches.filter((x) => isFavoriteBranch(x, null)).map((x) => x.name);
  const names = base.includes(b.name) ? base.filter((n) => n !== b.name) : [...base, b.name];
  useFavoriteBranches.setState({ names });
  try {
    localStorage.setItem(favoritesKey(), JSON.stringify(names));
  } catch {
    // Favorites last for the session only.
  }
}

export function notifyNotGit() {
  notifications().notify({ group: "vcs", level: "warning", title: "The project is not under Git version control" });
}
