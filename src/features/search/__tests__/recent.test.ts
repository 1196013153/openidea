import { describe, expect, it } from "vitest";
import type { ToolWindowContribution } from "@/workbench/contributions";
import {
  fromNavigationHistory,
  isDismissed,
  recordLocation,
  renameLocations,
  type RecentLocation,
} from "../common/locations";
import {
  filterLocations,
  filterRecentFiles,
  initialFileIndex,
  switcherPaths,
  switcherSelection,
  switcherToolWindows,
} from "../recent/model";

const loc = (path: string, line: number, extra: Partial<RecentLocation> = {}): RecentLocation => ({
  path,
  line,
  col: 0,
  snippet: [`line ${line}`],
  snippetStart: line,
  changed: false,
  time: line,
  ...extra,
});

describe("recent locations", () => {
  it("merges nearby caret moves and keeps the most recent first", () => {
    let list: RecentLocation[] = [];
    list = recordLocation(list, loc("/a", 10));
    list = recordLocation(list, loc("/b", 1));
    list = recordLocation(list, loc("/a", 12, { changed: true }));
    list = recordLocation(list, loc("/a", 13));
    expect(list.map((l) => `${l.path}:${l.line}`)).toEqual(["/a:13", "/b:1"]);
    expect(list[0]!.changed).toBe(true);
  });

  it("drops removed files", () => {
    expect(renameLocations([loc("/d/a", 1), loc("/e", 1)], "/d", null).map((l) => l.path)).toEqual(["/e"]);
  });

  it("normalises editor navigation history entries", () => {
    const out = fromNavigationHistory([{ path: "/a", selection: { line: 3, col: 2 } }, { path: "/b", line: 1, column: 4, text: "x" }, null, { nope: 1 }]);
    expect(out!.map((l) => [l.path, l.line, l.col, l.snippet])).toEqual([
      ["/a", 3, 2, []],
      ["/b", 1, 4, ["x"]],
    ]);
    expect(fromNavigationHistory("bad")).toBeNull();
  });

  it("filters by name, snippet and changed state", () => {
    const list = [loc("/p/Order.kt", 1, { snippet: ["val total"] }), loc("/p/Main.kt", 2, { changed: true })];
    expect(filterLocations(list, "ord", { changedOnly: false, root: "/p" }).map((l) => l.rel)).toEqual(["Order.kt"]);
    expect(filterLocations(list, "total", { changedOnly: false, root: "/p" }).map((l) => l.rel)).toEqual(["Order.kt"]);
    expect(filterLocations(list, "", { changedOnly: true, root: "/p" }).map((l) => l.rel)).toEqual(["Main.kt"]);
  });
});

describe("recent files switcher", () => {
  const paths = ["/p/src/Main.kt", "/p/src/Order.kt", "/p/README.md", "/p/src/Main.kt"];

  it("dedupes, filters and supports edited-only", () => {
    expect(filterRecentFiles(paths, "", { root: "/p" }).map((f) => f.rel)).toEqual(["src/Main.kt", "src/Order.kt", "README.md"]);
    const hit = filterRecentFiles(paths, "ord", { root: "/p" });
    expect(hit.map((f) => [f.name, f.indices])).toEqual([["Order.kt", [0, 1, 2]]]);
    expect(filterRecentFiles(paths, "src", { root: "/p" }).map((f) => f.name)).toEqual(["Main.kt", "Order.kt"]);
    expect(filterRecentFiles(paths, "", { root: "/p", editedOnly: true, edited: new Set(["/p/README.md"]) }).map((f) => f.name)).toEqual([
      "README.md",
    ]);
  });

  it("preselects the previous file when the current one is first", () => {
    const items = filterRecentFiles(paths, "", { root: "/p" });
    expect(initialFileIndex(items, "/p/src/Main.kt", "")).toBe(1);
    expect(initialFileIndex(items, "/p/other", "")).toBe(0);
    expect(initialFileIndex(items, "/p/src/Main.kt", "m")).toBe(0);
  });

  it("lists only open files in the switcher, most recent first", () => {
    expect(switcherPaths(["/c", "/x", "/a", "/c"], ["/a", "/b", "/c"])).toEqual(["/c", "/a", "/b"]);
  });

  it("moves the switcher selection past the end of the files into the tool windows", () => {
    expect(switcherSelection(1, 0, 3, 2)).toEqual({ column: "files", index: 1 });
    expect(switcherSelection(1, 2, 3, 2)).toEqual({ column: "tools", index: 0 });
    expect(switcherSelection(1, 4, 3, 2)).toEqual({ column: "files", index: 0 });
    expect(switcherSelection(0, -1, 3, 2)).toEqual({ column: "tools", index: 1 });
    expect(switcherSelection(3, -1, 3, 2)).toEqual({ column: "files", index: 2 });
    expect(switcherSelection(0, 0, 0, 0)).toBeNull();
  });

  it("orders tool windows by stripe", () => {
    const tw = (id: string, anchor: ToolWindowContribution["anchor"], order: number, extra: Partial<ToolWindowContribution> = {}) =>
      ({ id, title: id, icon: "folder", anchor, order, component: () => null, ...extra }) as ToolWindowContribution;
    const list = [tw("terminal", "bottom", 10), tw("project", "left", 0), tw("bookmarks", "left", 30, { secondary: true }), tw("structure", "left", 20)];
    expect(switcherToolWindows(list, true, "").map((x) => x.tw.id)).toEqual(["project", "structure", "bookmarks", "terminal"]);
    expect(switcherToolWindows(list, true, "ter").map((x) => x.tw.id)).toEqual(["terminal"]);
    expect(switcherToolWindows(list, false, "")).toEqual([]);
  });
});

describe("navigation history snapshot", () => {
  it("accepts the editor's { entries, index } snapshot and merges with recorded locations", async () => {
    const { mergeLocations } = await import("../common/locations");
    const history = fromNavigationHistory({ entries: [{ path: "/a", line: 1, col: 0, time: 1 }, { path: "/b", line: 50, col: 0, time: 3 }], index: 1 })!;
    const recorded = [loc("/a", 2, { time: 2, snippet: ["code"], changed: true })];
    const merged = mergeLocations(history, recorded);
    expect(merged.map((l) => `${l.path}:${l.line}`)).toEqual(["/b:50", "/a:2"]);
    expect(merged[1]!.changed).toBe(true);
    expect(merged[1]!.snippet).toEqual(["code"]);
  });
});

describe("removed recent locations", () => {
  it("hide the place until it is visited again", () => {
    const dismissed = [{ path: "/a", line: 10, time: 100 }];
    expect(isDismissed(loc("/a", 12, { time: 90 }), dismissed)).toBe(true);
    expect(isDismissed(loc("/a", 30, { time: 90 }), dismissed)).toBe(false);
    expect(isDismissed(loc("/b", 10, { time: 90 }), dismissed)).toBe(false);
    expect(isDismissed(loc("/a", 10, { time: 101 }), dismissed)).toBe(false);
  });
});
