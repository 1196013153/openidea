import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import type { CodeAction } from "@/bindings";
import { semanticRanges } from "./semantic";
import { lineErrorsAwayFromCaret, sortCodeActions } from "./intentions";
import { splitSignature } from "./signature";
import { dedupeLocations, usagesStatusText } from "./navigation";
import { declarationSummary } from "./markdown";
import { linkedSpans } from "./rename";
import { definitionSpan } from "./hover";

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

describe("lineErrorsAwayFromCaret", () => {
  const p = (from: number, to: number, severity = "error") => ({ from, to, severity });

  it("offers errors elsewhere on the caret line when none is at the caret", () => {
    expect(lineErrorsAwayFromCaret([p(30, 34), p(12, 15), p(50, 52), p(5, 6, "warning")], 0, 40, 2)).toEqual([p(12, 15), p(30, 34)]);
  });

  it("offers nothing extra when an error touches the caret", () => {
    expect(lineErrorsAwayFromCaret([p(0, 3), p(12, 15)], 0, 40, 3)).toEqual([]);
  });
});

describe("usagesStatusText", () => {
  it("reads like IDEA's status bar message", () => {
    expect(usagesStatusText(1, "'x'", "⇧⌘F7")).toBe(
      "1 usage of 'x' found (press ⇧⌘F7 again to remove the highlighting, Escape to remove all highlighting)",
    );
    expect(usagesStatusText(3, "'x'", null)).toBe("3 usages of 'x' found (Escape to remove all highlighting)");
  });
});

describe("declarationSummary", () => {
  it("takes the first code block of hover markdown", () => {
    expect(declarationSummary({ kind: "markdown", value: "```ts\nconst x: number\n```\n---\nDocs" })).toEqual({
      code: "const x: number",
      language: "ts",
    });
  });

  it("falls back to the first paragraph", () => {
    expect(declarationSummary({ kind: "plaintext", value: "fn main()\n\nmore" })).toEqual({ text: "fn main()" });
    expect(declarationSummary({ kind: "markdown", value: "  " })).toBeNull();
  });
});

describe("linkedSpans", () => {
  it("keeps other same-name occurrences, sorted and without the primary or overlaps", () => {
    const spans = [
      { from: 20, to: 23 },
      { from: 4, to: 7 },
      { from: 10, to: 13 },
      { from: 11, to: 14 },
      { from: 30, to: 35 },
    ];
    expect(linkedSpans(spans, { from: 4, to: 7 }, (s) => s.to - s.from === 3)).toEqual([
      { from: 10, to: 13 },
      { from: 20, to: 23 },
    ]);
  });
});

describe("definitionSpan", () => {
  const loc = { path: "/a.ts", range: { start: { line: 40, col: 9 }, end: { line: 40, col: 12 } } };
  const range = (a: number, b: number) => ({ start: { line: a, col: 0 }, end: { line: b, col: 1 } });

  it("shows the whole enclosing declaration when the syntax tree knows it", () => {
    expect(definitionSpan(loc, 500, range(38, 120))).toEqual({ first: 38, last: 120 });
  });

  it("falls back to a window around the name otherwise", () => {
    expect(definitionSpan(loc, 500, null)).toEqual({ first: 39, last: 52 });
    expect(definitionSpan(loc, 500, range(0, 10))).toEqual({ first: 39, last: 52 });
  });
});
