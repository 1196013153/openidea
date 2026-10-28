import { describe, expect, it } from "vitest";
import type { PrCheck, PrReviewComment, PullRequestDetails } from "@/platform/ipc";
import { checksSummary, checksText, diffNotes, fileDiffData, relativeTime, reviewThreads, stateLabel } from "./model";

const comment = (
  id: number,
  path: string,
  line: number | null,
  inReplyTo: number | null = null,
  side = "RIGHT",
): PrReviewComment => ({
  id,
  inReplyTo,
  path,
  line,
  originalLine: line ?? 3,
  side,
  body: `c${id}`,
  author: "ann",
  createdAt: "2026-10-21T10:00:00Z",
  url: "",
  diffHunk: "",
});

const summary = {
  number: 7,
  title: "Fix",
  author: "ann",
  state: "open" as const,
  isDraft: false,
  headRef: "fix",
  baseRef: "main",
  createdAt: "",
  updatedAt: "",
  labels: [],
  reviewDecision: null,
  url: "https://github.com/o/r/pull/7",
  additions: 1,
  deletions: 1,
};

describe("pull request model", () => {
  it("labels states", () => {
    expect(stateLabel(summary)).toBe("Open");
    expect(stateLabel({ ...summary, isDraft: true })).toBe("Draft");
    expect(stateLabel({ ...summary, state: "merged" })).toBe("Merged");
  });

  it("summarises checks", () => {
    const c = (status: PrCheck["status"]): PrCheck => ({ name: status, workflow: null, status, url: null });
    const s = checksSummary([c("failure"), c("success"), c("success"), c("pending"), c("skipped")]);
    expect(s).toEqual({ failed: 1, pending: 1, passed: 2, other: 1 });
    expect(checksText(s)).toBe("1 failing, 1 pending, 2 passed, 1 skipped");
    expect(checksText(checksSummary([]))).toBe("No checks");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(relativeTime("2026-10-21T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-21T10:00:00Z", now)).toBe("2 hours ago");
    expect(relativeTime("2026-10-20T12:00:00Z", now)).toBe("1 day ago");
    expect(relativeTime("nonsense", now)).toBe("");
  });

  it("threads replies under their root, ordered by file and line", () => {
    const threads = reviewThreads([
      comment(1, "b.ts", 9),
      comment(2, "a.ts", 5),
      comment(3, "b.ts", 9, 1),
      comment(4, "b.ts", 9, 3),
    ]);
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      [2, []],
      [1, [3, 4]],
    ]);
  });

  it("turns current comments into diff notes", () => {
    const notes = diffNotes("a.ts", [
      comment(1, "a.ts", 5),
      comment(2, "a.ts", null),
      comment(3, "a.ts", 2, null, "LEFT"),
      comment(4, "b.ts", 1),
    ]);
    expect(notes.map((n) => [n.side, n.line])).toEqual([
      ["right", 4],
      ["left", 1],
    ]);
  });

  it("builds diff data for renamed and added files", () => {
    const pr = { summary, files: [] } as unknown as PullRequestDetails;
    const revs = {
      base: "b".repeat(40),
      head: "h".repeat(40),
      root: "/repo",
      files: [{ path: "src/new.ts", kind: "renamed" as const, oldPath: "src/old.ts" }],
    };
    const renamed = fileDiffData(
      pr,
      { path: "src/new.ts", additions: 1, deletions: 0, changeType: "RENAMED" },
      revs,
      [],
    );
    expect(renamed.path).toBe("/repo/src/new.ts");
    expect(renamed.left).toMatchObject({ type: "rev", rev: revs.base, path: "/repo/src/old.ts" });
    expect(renamed.right).toMatchObject({ type: "rev", rev: revs.head });
    expect(renamed.title).toBe("#7: new.ts");
    const added = fileDiffData(pr, { path: "x.md", additions: 1, deletions: 0, changeType: "ADDED" }, revs, []);
    expect(added.left).toMatchObject({ type: "text", text: "" });
  });
});
