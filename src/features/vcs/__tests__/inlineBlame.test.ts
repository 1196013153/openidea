import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import type { BlameLine } from "@/bindings";
import {
  BlameCache,
  blameForLine,
  inlineBlameText,
  inlineBlameTooltip,
  relativeAge,
  type BlameSnapshot,
} from "../inlineBlame";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const DAY = 86_400_000;

const bl = (commit: string, summary = `subject ${commit}`, timeMs: number | null = NOW - 3 * DAY): BlameLine => ({
  commit,
  author: "张三",
  timeMs,
  summary,
});

const doc = (s: string) => Text.of(s.split("\n"));

/** Snapshot of `base` with one commit per line (`c1`, `c2`…). */
function snapshot(base: string): BlameSnapshot {
  const text = doc(base);
  return { base: text, lines: Array.from({ length: text.lines }, (_, i) => bl(`c${i + 1}`)) };
}

/** Applies `specs` one after another, composing the change sets. */
function edit(base: Text, ...specs: Array<{ from: number; to?: number; insert?: string }>) {
  let changes = ChangeSet.empty(base.length);
  let text = base;
  for (const spec of specs) {
    const c = ChangeSet.of(spec, text.length);
    text = c.apply(text);
    changes = changes.compose(c);
  }
  return { changes, text };
}

const commitOf = (snap: BlameSnapshot, changes: ChangeSet, text: Text, line: number) =>
  blameForLine(snap, changes, text, line)?.commit ?? null;

describe("relativeAge", () => {
  it("picks the largest whole unit", () => {
    expect(relativeAge(NOW - 20_000, NOW)).toBe("just now");
    expect(relativeAge(NOW + 60_000, NOW)).toBe("just now");
    expect(relativeAge(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(relativeAge(NOW - 5 * 3_600_000, NOW)).toBe("5 hours ago");
    expect(relativeAge(NOW - 3 * DAY, NOW)).toBe("3 days ago");
    expect(relativeAge(NOW - 65 * DAY, NOW)).toBe("2 months ago");
    expect(relativeAge(NOW - 400 * DAY, NOW)).toBe("1 year ago");
  });
});

describe("inlineBlameText", () => {
  it("shows author, age and subject", () => {
    expect(inlineBlameText(bl("c1", "fix: xxx"), NOW)).toBe("张三, 3 days ago · fix: xxx");
  });

  it("omits what is missing and shortens long subjects", () => {
    expect(inlineBlameText(bl("c1", "  "), NOW)).toBe("张三, 3 days ago");
    expect(inlineBlameText(bl("c1", "x", null), NOW)).toBe("张三 · x");
    const text = inlineBlameText(bl("c1", "y".repeat(100)), NOW);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThan(90);
  });

  it("puts the short hash, author, time and full subject in the tooltip", () => {
    const tip = inlineBlameTooltip({ ...bl("0123456789abcdef", "y".repeat(100)) });
    expect(tip.startsWith("01234567  张三  ")).toBe(true);
    expect(tip.endsWith(`\n${"y".repeat(100)}`)).toBe(true);
  });
});

describe("blameForLine", () => {
  const base = "alpha\nbeta\ngamma";

  it("returns the line's commit without edits", () => {
    const snap = snapshot(base);
    const { changes, text } = edit(snap.base);
    expect([1, 2, 3].map((n) => commitOf(snap, changes, text, n))).toEqual(["c1", "c2", "c3"]);
  });

  it("follows lines moved by whole lines inserted or deleted above them", () => {
    const snap = snapshot(base);
    const inserted = edit(snap.base, { from: 6, insert: "new\n" });
    expect([1, 2, 3, 4].map((n) => commitOf(snap, inserted.changes, inserted.text, n))).toEqual([
      "c1",
      null,
      "c2",
      "c3",
    ]);
    const deleted = edit(snap.base, { from: 0, to: 6 });
    expect([1, 2].map((n) => commitOf(snap, deleted.changes, deleted.text, n))).toEqual(["c2", "c3"]);
  });

  it("shows nothing on edited, split and duplicated lines", () => {
    const snap = snapshot(base);
    const typed = edit(snap.base, { from: 10, insert: "!" });
    expect([1, 2, 3].map((n) => commitOf(snap, typed.changes, typed.text, n))).toEqual(["c1", null, "c3"]);
    // "beta" split into "be" / "ta".
    const split = edit(snap.base, { from: 8, insert: "\n" });
    expect([2, 3, 4].map((n) => commitOf(snap, split.changes, split.text, n))).toEqual([null, null, "c3"]);
    // Duplicate Line on "alpha": the copy below is new.
    const dup = edit(snap.base, { from: 5, insert: "\nalpha" });
    expect([1, 2, 3].map((n) => commitOf(snap, dup.changes, dup.text, n))).toEqual(["c1", null, "c2"]);
    // Lines joined.
    const joined = edit(snap.base, { from: 5, to: 6 });
    expect([1, 2].map((n) => commitOf(snap, joined.changes, joined.text, n))).toEqual([null, "c3"]);
  });

  it("maps through several edits, including ones that restore the text", () => {
    const snap = snapshot(base);
    const { changes, text } = edit(snap.base, { from: 0, insert: "x\n" }, { from: 2, to: 8 }, { from: 0, to: 2 });
    expect(text.toString()).toBe("beta\ngamma");
    expect([1, 2].map((n) => commitOf(snap, changes, text, n))).toEqual(["c2", "c3"]);
  });

  it("shows nothing for uncommitted lines or a stale change set", () => {
    const snap = snapshot(base);
    const withUncommitted: BlameSnapshot = { ...snap, lines: [snap.lines[0]!, bl("0000000000"), snap.lines[2]!] };
    const { changes, text } = edit(snap.base);
    expect(commitOf(withUncommitted, changes, text, 2)).toBeNull();
    expect(commitOf(snap, changes, doc("other"), 1)).toBeNull();
    // Fewer blame lines than document lines (trailing newline).
    expect(commitOf({ ...snap, lines: snap.lines.slice(0, 2) }, changes, text, 3)).toBeNull();
  });
});

describe("BlameCache", () => {
  it("fetches once per file and text until invalidated", async () => {
    const fetch = vi.fn(async (path: string) => [bl(path)]);
    const cache = new BlameCache(fetch);
    const text = doc("a\nb");
    const first = await cache.get("/r/a.ts", text);
    expect(first?.lines[0]?.commit).toBe("/r/a.ts");
    expect(first?.base).toBe(text);
    await cache.get("/r/a.ts", doc("a\nb"));
    expect(fetch).toHaveBeenCalledTimes(1);
    // Different text (another editor with unsaved edits): asks again.
    await cache.get("/r/a.ts", doc("a\nb!"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("notifies on invalidation and refetches", async () => {
    const fetch = vi.fn(async () => [bl("c1")]);
    const cache = new BlameCache(fetch);
    const seen: Array<string | null> = [];
    const off = cache.subscribe((p) => seen.push(p));
    const text = doc("a");
    await cache.get("/r/a.ts", text);
    await cache.get("/r/b.ts", text);
    cache.invalidate("/r/a.ts");
    expect(cache.has("/r/a.ts")).toBe(false);
    expect(cache.has("/r/b.ts")).toBe(true);
    await cache.get("/r/a.ts", text);
    expect(fetch).toHaveBeenCalledTimes(3);
    cache.invalidate();
    expect(cache.has("/r/b.ts")).toBe(false);
    off();
    cache.invalidate("/r/a.ts");
    expect(seen).toEqual(["/r/a.ts", null]);
  });

  it("remembers failures as null without retrying", async () => {
    const fetch = vi.fn(async (): Promise<BlameLine[]> => {
      throw new Error("not a git repository");
    });
    const cache = new BlameCache(fetch);
    const text = doc("a");
    expect(await cache.get("/tmp/x", text)).toBeNull();
    expect(await cache.get("/tmp/x", text)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    cache.invalidate("/tmp/x");
    await cache.get("/tmp/x", text);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
