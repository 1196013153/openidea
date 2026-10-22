/** Pull request operations shared by the view and the `github.*` actions. */
import type { PrFile, PullRequestDetails, ReviewEvent } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { notifications, toolWindowService } from "@/workbench/contributions";
import { createPullRequestDialog, numberDialog, reviewDialog } from "./dialogs";
import { fileDiffData } from "./model";
import { diffRevisions, errorMessage, loadDetails, loadList, readyRepo, refreshAll, useGithub, withBusy } from "./store";

export const WINDOW = "pullRequests";

export async function openUrl(url: string) {
  try {
    const { openUrl: open } = await import("@tauri-apps/plugin-opener");
    await open(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/** Shows the tool window, (re)checking gh first when needed. */
export async function showPullRequests() {
  toolWindowService().show(WINDOW, true);
  if (useGithub.getState().availability?.kind !== "ready") await refreshAll();
}

function notReady(): boolean {
  const a = useGithub.getState().availability;
  if (a?.kind === "ready") return false;
  void showPullRequests();
  return true;
}

export async function checkoutPullRequest(number: number) {
  const done = await withBusy(`Checking out #${number}…`, (r, out) => call(commands.ghPrCheckout(r, number, out)));
  if (done !== null)
    notifications().notify({ group: "vcs", level: "info", title: `Checked out pull request #${number}`, key: "github-checkout" });
}

/** Git › GitHub › Checkout Pull Request…: the selected one, else asks for a number. */
export async function checkoutAction(arg: unknown) {
  if (useGithub.getState().availability?.kind !== "ready") await refreshAll();
  if (notReady()) return;
  const n = typeof arg === "number" ? arg : (useGithub.getState().selected ?? (await numberDialog("Checkout Pull Request")));
  if (n) await checkoutPullRequest(n);
}

export async function openFileDiff(pr: PullRequestDetails, file: PrFile) {
  const revs = await diffRevisions(pr);
  if (!revs) return;
  await executeAction("vcs.openDiff", fileDiffData(pr, file, revs, useGithub.getState().reviewComments));
}

/** Opens a review comment's file at its line in the PR diff. */
export async function openCommentLocation(pr: PullRequestDetails, path: string) {
  const file = pr.files.find((f) => f.path === path) ?? { path, additions: 0, deletions: 0, changeType: "MODIFIED" };
  await openFileDiff(pr, file);
}

export async function submitReview(number: number, initial: ReviewEvent) {
  const r = await reviewDialog(number, initial);
  if (!r) return;
  try {
    await call(commands.ghPrReview(number, r.event, r.body));
    notifications().notify({ group: "vcs", level: "info", title: `Review submitted on #${number}`, key: "github-review" });
    await loadDetails(number);
  } catch (e) {
    notifications().notify({ group: "vcs", level: "error", title: "Could not submit the review", body: errorMessage(e), key: "github-review" });
  }
}

export async function addComment(number: number, body: string): Promise<boolean> {
  try {
    await call(commands.ghPrComment(number, body));
    await loadDetails(number);
    return true;
  } catch (e) {
    notifications().notify({ group: "vcs", level: "error", title: "Could not add the comment", body: errorMessage(e), key: "github-comment" });
    return false;
  }
}

/** Git › GitHub › Create Pull Request…: from the current branch. */
export async function createPullRequest() {
  if (useGithub.getState().availability?.kind !== "ready") await refreshAll();
  if (notReady()) return;
  const repo = readyRepo();
  let head: string | null = null;
  let needsPush = true;
  let title = "";
  try {
    const info = await call(commands.vcsBranchInfo());
    head = info.head;
    needsPush = !info.upstream || info.ahead > 0;
    if (head) title = head.replace(/^[^/]+\//, "").replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  } catch {
    // Not a git repository: gh will explain.
  }
  if (!head) {
    notifications().notify({ group: "vcs", level: "warning", title: "Check out a branch to create a pull request from", key: "github-create" });
    return;
  }
  if (head === repo?.defaultBranch) {
    notifications().notify({
      group: "vcs",
      level: "warning",
      title: `'${head}' is the default branch`,
      body: "Create a branch for your changes first.",
      key: "github-create",
      actions: [{ label: "New Branch…", run: () => void executeAction("vcs.newBranch") }],
    });
    return;
  }
  const input = await createPullRequestDialog({ head, defaultBase: repo?.defaultBranch ?? null, title, needsPush });
  if (!input) return;
  const url = await withBusy(`Creating pull request…`, (r, out) => call(commands.ghPrCreate(r, input, out)));
  if (url === null) return;
  notifications().notify({
    group: "vcs",
    level: "info",
    title: "Pull request created",
    body: url || undefined,
    key: "github-create",
    actions: url ? [{ label: "Open in Browser", run: () => void openUrl(url) }] : undefined,
  });
  toolWindowService().show(WINDOW);
  await loadList();
  const m = /\/pull\/(\d+)/.exec(url);
  if (m) await loadDetails(Number(m[1]));
}

/** Opens the selected pull request, else the repository, on GitHub. */
export async function openInBrowser() {
  if (useGithub.getState().availability?.kind !== "ready") await refreshAll();
  if (notReady()) return;
  const { details } = useGithub.getState();
  const url = details?.summary.url ?? readyRepo()?.url;
  if (url) await openUrl(url);
}
