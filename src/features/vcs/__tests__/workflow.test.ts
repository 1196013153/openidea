import { describe, expect, it } from "vitest";
import { messageProblems, wrapAtMargin } from "../CommitView";
import { linkifyIssues } from "../issueLinks";
import { isProtectedBranch, isPushRejected } from "../remoteUi";
import { statusDecorations } from "../model";

const cfg = { blankLineAfterSubject: true, limitSubject: true, subjectLimit: 10, limitBody: true, bodyLimit: 8 };

describe("commit message inspections", () => {
  it("reports subject length, missing blank line and long body lines", () => {
    expect(messageProblems("short", cfg)).toEqual([]);
    expect(messageProblems("a subject that is long\nbody", cfg)).toEqual([
      "Subject line is longer than 10 characters",
      "Missing blank line between subject and body",
    ]);
    expect(messageProblems("ok\n\nthis body line is long", cfg)).toEqual(["Body line 3 is longer than 8 characters"]);
    expect(messageProblems("x".repeat(20), { ...cfg, limitSubject: false })).toEqual([]);
  });

  it("wraps body lines at the last space before the margin", () => {
    const text = "subject\n\nhello world again";
    expect(wrapAtMargin(text, text.length, 12)).toEqual({ text: "subject\n\nhello world\nagain", caret: text.length });
    expect(wrapAtMargin("a very long subject line", 5, 5)).toBeNull();
  });
});

describe("issue navigation", () => {
  it("links every match with $0 / $n substitution", () => {
    const links = [
      { pattern: "[A-Z]+-\\d+", link: "https://jira/browse/$0" },
      { pattern: "#(\\d+)", link: "https://gh/issues/$1" },
      { pattern: "(", link: "broken" },
    ];
    expect(linkifyIssues("Fix OPENIDEA-12 and #7.", links)).toEqual([
      "Fix ",
      { text: "OPENIDEA-12", url: "https://jira/browse/OPENIDEA-12" },
      " and ",
      { text: "#7", url: "https://gh/issues/7" },
      ".",
    ]);
  });
});

describe("git settings helpers", () => {
  it("matches protected branch globs", () => {
    expect(isProtectedBranch("main", "master; main")).toBe(true);
    expect(isProtectedBranch("release/1.2", "release/*")).toBe(true);
    expect(isProtectedBranch("feature", "master, main")).toBe(false);
  });

  it("recognises rejected pushes", () => {
    expect(isPushRejected(" ! [rejected]        main -> main (fetch first)")).toBe(true);
    expect(isPushRejected("Permission denied (publickey)")).toBe(false);
  });

  it("propagates folder colours only when enabled", () => {
    const status = [{ path: "/p/src/a.ts", relPath: "src/a.ts", staged: null, unstaged: "modified" as const, renamedFrom: null }];
    expect(statusDecorations(status).get("/p/src/a.ts")?.propagate).toBe(true);
    expect(statusDecorations(status, false).get("/p/src/a.ts")?.propagate).toBeUndefined();
  });
});
