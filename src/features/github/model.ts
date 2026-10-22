/** Pure helpers of the Pull Requests view (labels, check summaries, review threads, diff inputs). */
import type { ChangedFile, PrCheck, PrDiffRevisions, PrFile, PrReviewComment, PullRequestDetails, PullRequestSummary } from "@/platform/ipc";

export function stateLabel(pr: PullRequestSummary): string {
  if (pr.state === "merged") return "Merged";
  if (pr.state === "closed") return "Closed";
  return pr.isDraft ? "Draft" : "Open";
}

export function reviewDecisionLabel(decision: string | null): string | null {
  switch (decision) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "REVIEW_REQUIRED":
      return "Review required";
    default:
      return null;
  }
}

export function reviewStateLabel(state: string): string {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "COMMENTED":
      return "reviewed";
    case "DISMISSED":
      return "review dismissed";
    case "REQUESTED":
      return "review requested";
    default:
      return state.toLowerCase().replace(/_/g, " ");
  }
}

export interface ChecksSummary {
  failed: number;
  pending: number;
  passed: number;
  /** Skipped / neutral / cancelled. */
  other: number;
}

export function checksSummary(checks: readonly PrCheck[]): ChecksSummary {
  const s: ChecksSummary = { failed: 0, pending: 0, passed: 0, other: 0 };
  for (const c of checks) {
    if (c.status === "failure") s.failed++;
    else if (c.status === "pending") s.pending++;
    else if (c.status === "success") s.passed++;
    else s.other++;
  }
  return s;
}

export function checksText(s: ChecksSummary): string {
  const parts: string[] = [];
  if (s.failed) parts.push(`${s.failed} failing`);
  if (s.pending) parts.push(`${s.pending} pending`);
  if (s.passed) parts.push(`${s.passed} successful`);
  if (s.other) parts.push(`${s.other} skipped`);
  return parts.length ? parts.join(", ") : "No checks";
}

/** "3 minutes ago"-style text for an ISO date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  const units: Array<[number, string]> = [
    [60 * 60 * 24 * 365, "year"],
    [60 * 60 * 24 * 30, "month"],
    [60 * 60 * 24, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

export interface ReviewThread {
  root: PrReviewComment;
  replies: PrReviewComment[];
}

/** Groups inline comments into threads (replies under their root), roots in file / line order. */
export function reviewThreads(comments: readonly PrReviewComment[]): ReviewThread[] {
  const byId = new Map<number, ReviewThread>();
  const threads: ReviewThread[] = [];
  for (const c of comments) {
    const parent = c.inReplyTo != null ? byId.get(c.inReplyTo) : undefined;
    if (parent) {
      parent.replies.push(c);
      byId.set(c.id, parent);
    } else {
      const t = { root: c, replies: [] };
      threads.push(t);
      byId.set(c.id, t);
    }
  }
  return threads.sort(
    (a, b) => a.root.path.localeCompare(b.root.path) || (a.root.line ?? a.root.originalLine ?? 0) - (b.root.line ?? b.root.originalLine ?? 0),
  );
}

/** Annotation shape of the diff viewer (`vcs.openDiff` → DiffData.annotations). */
export interface DiffNote {
  side: "left" | "right";
  line: number;
  author: string;
  body: string;
  date?: string;
}

/** Current (not outdated) review comments of `path`, as diff notes. */
export function diffNotes(path: string, comments: readonly PrReviewComment[]): DiffNote[] {
  return comments
    .filter((c) => c.path === path && c.line != null)
    .map((c) => ({ side: c.side === "LEFT" ? "left" : "right", line: c.line! - 1, author: c.author, body: c.body, date: c.createdAt }));
}

type Side =
  | { type: "rev"; rev: string; path?: string; label?: string }
  | { type: "text"; text: string; label: string };

/** `DiffData` for one changed file of a pull request (merge base ↔ head), with its review comments. */
export function fileDiffData(pr: PullRequestDetails, file: PrFile, revs: PrDiffRevisions, comments: readonly PrReviewComment[]) {
  const root = revs.root;
  const changed: ChangedFile | undefined = revs.files.find((f) => f.path === file.path);
  const added = file.changeType === "ADDED" || changed?.kind === "added";
  const deleted = file.changeType === "DELETED" || changed?.kind === "deleted";
  const n = pr.summary.number;
  const left: Side = added
    ? { type: "text", text: "", label: "(does not exist)" }
    : {
        type: "rev",
        rev: revs.base,
        path: changed?.oldPath ? `${root}/${changed.oldPath}` : undefined,
        label: `${pr.summary.baseRef} (${revs.base.slice(0, 8)})`,
      };
  const right: Side = deleted ? { type: "text", text: "", label: "(deleted)" } : { type: "rev", rev: revs.head, label: `#${n} ${pr.summary.headRef}` };
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  return { path: `${root}/${file.path}`, left, right, title: `#${n}: ${name}`, annotations: diffNotes(file.path, comments) };
}
