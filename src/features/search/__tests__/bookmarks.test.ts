import { beforeEach, describe, expect, it } from "vitest";
import {
  linesOf,
  loadBookmarks,
  renameBookmarks,
  setFileLines,
  toggleBookmark,
  updateBookmarks,
  useBookmarks,
  type Bookmark,
} from "../bookmarks/store";

describe("bookmark helpers", () => {
  it("toggles on and off, keeping the list sorted", () => {
    let list: Bookmark[] = [];
    list = toggleBookmark(list, "/p/b.kt", 3, "  val x = 1  ", 1);
    list = toggleBookmark(list, "/p/a.kt", 9, "fun a()", 2);
    list = toggleBookmark(list, "/p/b.kt", 1, "import", 3);
    expect(list.map((b) => `${b.path}:${b.line}`)).toEqual(["/p/a.kt:9", "/p/b.kt:1", "/p/b.kt:3"]);
    expect(list[2]!.text).toBe("val x = 1");
    list = toggleBookmark(list, "/p/b.kt", 1, "import");
    expect(linesOf(list, "/p/b.kt")).toEqual([3]);
  });

  it("moves lines after edits and collapses duplicates", () => {
    const list = [
      { path: "/p/a", line: 1, text: "a", created: 1 },
      { path: "/p/a", line: 5, text: "b", created: 2 },
      { path: "/p/z", line: 0, text: "z", created: 3 },
    ];
    const moved = setFileLines(list, "/p/a", [
      { line: 3, text: "a" },
      { line: 3, text: "b" },
    ]);
    expect(moved.map((b) => `${b.path}:${b.line}`)).toEqual(["/p/a:3", "/p/z:0"]);
    expect(moved[0]!.created).toBe(1);
  });

  it("follows renames and drops deleted files", () => {
    const list = [
      { path: "/p/dir/a", line: 1, text: "", created: 1 },
      { path: "/p/other", line: 2, text: "", created: 1 },
    ];
    expect(renameBookmarks(list, "/p/dir", "/p/new").map((b) => b.path)).toEqual(["/p/new/a", "/p/other"]);
    expect(renameBookmarks(list, "/p/dir", null).map((b) => b.path)).toEqual(["/p/other"]);
  });
});

describe("bookmark store", () => {
  beforeEach(() => localStorage.clear());

  it("persists per project", () => {
    loadBookmarks("/p1");
    updateBookmarks((l) => toggleBookmark(l, "/p1/a", 0, "x"));
    loadBookmarks("/p2");
    expect(useBookmarks.getState().items).toEqual([]);
    loadBookmarks("/p1");
    expect(linesOf(useBookmarks.getState().items, "/p1/a")).toEqual([0]);
  });

  it("ignores corrupt storage", () => {
    localStorage.setItem("openidea.bookmarks.v1:/bad", JSON.stringify([{ path: 1 }, { path: "/bad/x", line: 2 }, "nope"]));
    loadBookmarks("/bad");
    expect(useBookmarks.getState().items.map((b) => b.line)).toEqual([2]);
  });
});
