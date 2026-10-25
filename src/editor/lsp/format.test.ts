import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { formattedLines } from "./format";

describe("formattedLines", () => {
  const doc = Text.of(["fn  main(){", "let x=1;", "}", "", "fn other() {}"]);
  const lineStart = (n: number) => doc.line(n).from;

  it("counts the lines of the result the changes touched", () => {
    expect(
      formattedLines(doc, [
        { from: lineStart(1) + 2, to: lineStart(1) + 4, insert: " " },
        { from: lineStart(1) + 10, to: lineStart(1) + 10, insert: " " },
        { from: lineStart(2), to: lineStart(2), insert: "    " },
      ]),
    ).toBe(2);
  });

  it("numbers lines as in the new text when a change adds lines", () => {
    // `{}` split over two lines, then a change on (old) line 5 = new line 6.
    expect(
      formattedLines(doc, [
        { from: lineStart(5) + 11, to: lineStart(5) + 12, insert: "{\n" },
        { from: lineStart(1), to: lineStart(1) + 1, insert: "f" },
      ]),
    ).toBe(3);
  });
});
