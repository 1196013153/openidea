import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import type { CodeAction } from "@/bindings";
import { semanticRanges } from "./semantic";
import { sortCodeActions } from "./intentions";
import { splitSignature } from "./signature";
import { dedupeLocations } from "./navigation";

describe("semanticRanges", () => {
  const doc = Text.of(["let mut count = Foo::new();", "const MAX: u32 = 1;"]);
  const tokens = {
    tokenTypes: ["variable", "struct", "function", "keyword"],
    tokenModifiers: ["mutable", "constant", "static", "deprecated"],
    // [line, col, len, type, modifiers]
    data: [0, 8, 5, 0, 0b0001, 0, 16, 3, 1, 0, 0, 21, 3, 2, 0b1000, 1, 6, 3, 0, 0b0010, 0, 0, 3, 3, 0, 9, 0, 1, 1, 0],
  };

  it("maps types and modifiers to classes and skips plain variables / unknown types", () => {
    expect(semanticRanges(doc, tokens)).toEqual([
      { from: 8, to: 13, className: "cm-sem-mutable" },
      { from: 16, to: 19, className: "cm-sem-type" },
      { from: 21, to: 24, className: "cm-sem-function cm-sem-deprecated" },
      { from: 34, to: 37, className: "cm-sem-constant" },
    ]);
  });
});

describe("sortCodeActions", () => {
  const a = (title: string, kind: string | null, isPreferred = false, disabledReason: string | null = null): CodeAction => ({
    title,
    kind,
    isPreferred,
    disabledReason,
    edit: null,
    command: null,
    data: null,
    server: 1,
  });

  it("puts preferred quick fixes first and disabled actions last", () => {
    const sorted = sortCodeActions([
      a("extract", "refactor.extract"),
      a("disabled fix", "quickfix", false, "nope"),
      a("fix", "quickfix"),
      a("preferred fix", "quickfix.import", true),
      a("preferred refactor", "refactor", true),
    ]);
    expect(sorted.map((x) => x.title)).toEqual(["preferred fix", "fix", "preferred refactor", "extract", "disabled fix"]);
  });
});

describe("splitSignature", () => {
  it("splits around the active parameter", () => {
    const label = "fn create(req: Request, user: Long) -> Order";
    expect(splitSignature(label, [[10, 22], [24, 34]], 1)).toEqual({
      before: "fn create(req: Request, ",
      param: "user: Long",
      after: ") -> Order",
    });
    expect(splitSignature(label, [], 0).param).toBe("");
  });
});

describe("dedupeLocations", () => {
  it("drops duplicate targets", () => {
    const loc = (path: string, line: number) => ({ path, range: { start: { line, col: 0 }, end: { line, col: 1 } } });
    expect(dedupeLocations([loc("/a", 1), loc("/a", 1), loc("/b", 1)])).toHaveLength(2);
  });
});
