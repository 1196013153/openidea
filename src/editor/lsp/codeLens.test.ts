import { describe, expect, it } from "vitest";
import type { OutlineItem } from "@/platform/ipc";
import { lensTargets } from "./codeLens";

const item = (name: string, kind: OutlineItem["kind"], line: number, children: OutlineItem[] = []): OutlineItem => {
  const r = { start: { line, col: 0 }, end: { line, col: 1 } };
  return { name, kind, detail: null, range: r, selection_range: r, children };
};

describe("usages lens targets", () => {
  it("skips callbacks and anonymous functions", () => {
    const items = [
      item("Cart", "class", 0, [
        item("count", "method", 1, [item("reduce() callback", "function", 2)]),
        item("<function>", "function", 3),
      ]),
    ];
    expect(lensTargets(items).map((t) => t.name)).toEqual(["Cart", "count"]);
  });
});
