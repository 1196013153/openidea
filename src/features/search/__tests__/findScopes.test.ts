import { describe, expect, it } from "vitest";
import { FILE_SET_SCOPES, buildQuery, describeQuery, findHistory, rememberFindString, useFindPopup } from "../find/store";
import { selectRow, selectedRows, type RowSelection } from "../find/rowSelection";

describe("Find in Files named scopes", () => {
  it("defaults to IDEA's Project Files and maps root-based scopes to backend file sets", () => {
    expect(useFindPopup.getState().namedScope).toBe("projectFiles");
    expect(FILE_SET_SCOPES).toEqual({ projectFiles: "all", productionFiles: "production", testFiles: "test" });
    const q = buildQuery(useFindPopup.getState(), { kind: "fileSet", set: "test" }, 0);
    expect(q.scope).toEqual({ kind: "fileSet", set: "test" });
    expect(describeQuery({ ...q, pattern: "x" }, "/p")).toBe("'x' in Project Test Files");
    expect(describeQuery({ ...q, pattern: "x", scope: { kind: "fileSet", set: "production" } }, "/p")).toBe(
      "'x' in Project Production Files",
    );
  });
});

describe("Find in Files search context and history", () => {
  it("sends the context filter only when it narrows the search", () => {
    const base = useFindPopup.getState();
    expect(buildQuery(base, { kind: "project" }, 0)).not.toHaveProperty("context");
    const q = buildQuery({ ...base, pattern: "x", context: "exceptComments" }, { kind: "project" }, 0);
    expect(q.context).toBe("exceptComments");
    expect(describeQuery(q, "/p")).toBe("'x' in Project, except comments");
  });

  it("remembers recent strings per field, newest first and unique", () => {
    localStorage.clear();
    rememberFindString("find", "a");
    rememberFindString("find", "b");
    rememberFindString("find", "a");
    rememberFindString("replace", "r");
    rememberFindString("find", "  ");
    expect(findHistory("find")).toEqual(["a", "b"]);
    expect(findHistory("replace")).toEqual(["r"]);
  });
});

describe("results selection", () => {
  const rows = ["a", "b", "c", "d"].map((key) => ({ key }));
  const keys = (sel: RowSelection) => selectedRows(rows, sel).map((r) => r.key);

  it("⇧ extends from the anchor, ⌘ toggles, a plain click selects one", () => {
    let sel = selectRow(rows, { lead: 0, anchor: 0, keys: null }, 1);
    sel = selectRow(rows, sel, 3, "range");
    expect(keys(sel)).toEqual(["b", "c", "d"]);
    sel = selectRow(rows, sel, 0, "range");
    expect(keys(sel)).toEqual(["a", "b"]);
    sel = selectRow(rows, sel, 3, "toggle");
    expect(keys(sel)).toEqual(["a", "b", "d"]);
    sel = selectRow(rows, sel, 3, "toggle");
    expect(keys(sel)).toEqual(["a", "b"]);
    expect(sel.lead).toBe(1);
    sel = selectRow(rows, sel, 2);
    expect(keys(sel)).toEqual(["c"]);
  });
});
