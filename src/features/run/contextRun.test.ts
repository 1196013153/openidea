import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { menuGroupItems, registerMenuGroup } from "@/workbench/contributions";
import { contextMenuItems } from "./contextRun";
import { useRun } from "./store";

const ROOT = "/work/app";
const SCRATCHES = "/Users/me/scratches";

const npmTest: RunConfig = {
  id: "npm:test",
  name: "test",
  kind: "npm",
  command: "npm",
  args: ["run", "test"],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: "js-debug",
};

type Item = ReturnType<typeof contextMenuItems>[number];
// Flattens "More Run/Debug" so its entries read in menu order.
const labels = (items: Item[]): string[] =>
  items.flatMap((i) =>
    i.kind === "action"
      ? [`${i.action}|${i.label}|${i.icon}`]
      : i.kind === undefined || i.kind === "item"
        ? "submenu" in i && i.submenu
          ? labels(i.submenu)
          : [i.label]
        : [i.kind],
  );

describe("run context menu group", () => {
  beforeEach(() => {
    useProject.setState({ project: { name: "app", root: ROOT, isGit: false, settings: {} } as never });
    useRun.setState({ configs: [npmTest], loaded: true });
  });
  afterEach(() => {
    useProject.setState({ project: null });
    useRun.setState({ configs: [], loaded: false });
  });

  it("editor: Run / Debug '<file>' and More Run/Debug › Modify Run Configuration… for a runnable scratch", () => {
    const items = contextMenuItems("editor", { paths: [`${SCRATCHES}/hi.ts`], text: "console.log(123)", line: 0 });
    expect(labels(items)).toEqual([
      "run.runContext|Run 'hi.ts'|run",
      "run.debugContext|Debug 'hi.ts'|debug",
      "run.modifyContext|Modify Run Configuration…|edit",
    ]);
    // The actions get the context (path + caret line), so the menu runs what it shows.
    expect(items[0]).toMatchObject({ arg: { path: `${SCRATCHES}/hi.ts`, line: 0, dir: false } });
  });

  it("editor: the element at the caret names the entries", () => {
    const text = "describe('math', () => {\n  it('adds', () => {\n    expect(1).toBe(1);\n  });\n});\n";
    const at = (line: number) => contextMenuItems("editor", { paths: [`${ROOT}/src/m.test.ts`], text, line })[0];
    expect(at(2)).toMatchObject({ label: "Run 'math > adds'" });
    expect(at(0)).toMatchObject({ label: "Run 'math'" });
  });

  it("tabs and the project view use the file, not the caret", () => {
    const text = "describe('math', () => {\n  it('adds', () => {});\n});\n";
    const tab = contextMenuItems("editorTab", { paths: [`${ROOT}/src/m.test.ts`], text, line: 1 });
    expect(tab[0]).toMatchObject({ label: "Run 'm.test.ts'" });
    const view = contextMenuItems("projectView", { paths: [`${ROOT}/src/m.test.ts`], dirs: [false] });
    expect(view[1]).toMatchObject({ label: "Debug 'm.test.ts'" });
  });

  it("project view: test directories", () => {
    const items = contextMenuItems("projectView", { paths: [`${ROOT}/src/__tests__`], dirs: [true] });
    expect(items[0]).toMatchObject({ label: "Run 'Tests in '__tests__''", arg: { dir: true } });
    expect(contextMenuItems("projectView", { paths: [`${ROOT}/src/components`], dirs: [true] })).toEqual([]);
  });

  it("shows nothing when no producer matches or for several paths", () => {
    expect(contextMenuItems("editor", { paths: [`${ROOT}/README.md`], text: "# hi", line: 0 })).toEqual([]);
    expect(contextMenuItems("projectView", { paths: [`${ROOT}/a.js`, `${ROOT}/b.js`], dirs: [false, false] })).toEqual([]);
    useProject.setState({ project: null });
    expect(contextMenuItems("editor", { paths: [`${SCRATCHES}/hi.ts`], text: "", line: 0 })).toEqual([]);
  });
});

describe("menuGroupItems", () => {
  it("collects contributed groups in order, each followed by a separator", () => {
    const off = [
      registerMenuGroup({ id: "b", menus: ["editor"], order: 2, items: () => [{ label: "B" }] }),
      registerMenuGroup({ id: "a", menus: ["editor", "editorTab"], order: 1, items: () => [{ label: "A" }] }),
      registerMenuGroup({ id: "empty", menus: ["editor"], items: () => [] }),
      registerMenuGroup({
        id: "broken",
        menus: ["editor"],
        items: () => {
          throw new Error("x");
        },
      }),
    ];
    const prev = console.error;
    console.error = () => {};
    try {
      expect(menuGroupItems("editor", { paths: ["/a"] })).toEqual([
        { label: "A" },
        { kind: "separator" },
        { label: "B" },
        { kind: "separator" },
      ]);
      expect(menuGroupItems("editorTab", { paths: ["/a"] })).toEqual([{ label: "A" }, { kind: "separator" }]);
      expect(menuGroupItems("projectView", { paths: ["/a"] })).toEqual([]);
    } finally {
      console.error = prev;
      off.forEach((d) => d());
    }
    expect(menuGroupItems("editor", { paths: ["/a"] })).toEqual([]);
  });
});

describe("debug entry", () => {
  beforeEach(() => {
    useProject.setState({ project: { name: "app", root: ROOT, isGit: false, settings: {} } as never });
    useRun.setState({ configs: [], loaded: true });
  });
  afterEach(() => useProject.setState({ project: null }));

  it("is left out when nothing can debug the file", () => {
    const sh = contextMenuItems("projectView", { paths: [`${SCRATCHES}/a.sh`], dirs: [false] });
    expect(labels(sh)).toEqual(["run.runContext|Run 'a.sh'|run", "run.modifyContext|Modify Run Configuration…|edit"]);
    const rs = contextMenuItems("editor", { paths: [`${SCRATCHES}/a.rs`], text: "fn main() {}", line: 0 });
    expect(labels(rs)[1]).toBe("run.debugContext|Debug 'a.rs'|debug");
  });
});
