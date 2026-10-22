import { describe, expect, it } from "vitest";
import { Chunk, MergeView } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { applyChunk, arrowControls } from "../diffControls";
import { DEFAULT_DIFF_OPTIONS, parseDiffOptions, transferChunk, whitespaceDiff, type IgnorePolicy } from "../diffOptions";
import { clipboardDiffData, compareFilesData, parseTextsArg } from "../compare";
import { diffInput, diffTitle, sideFile, sideKey } from "../diffInput";

const doc = (s: string) => Text.of(s.split("\n"));

function chunks(a: string, b: string, ignore: IgnorePolicy) {
  const override = whitespaceDiff(ignore);
  return Chunk.build(doc(a), doc(b), override ? { override } : undefined);
}

describe("diff options", () => {
  it("parses stored options with per-field defaults", () => {
    expect(parseDiffOptions(null)).toEqual(DEFAULT_DIFF_OPTIONS);
    expect(
      parseDiffOptions({ mode: "split", ignore: "trim", highlight: "lines", collapse: false, syncScroll: false }),
    ).toEqual({ mode: "split", ignore: "trim", highlight: "lines", collapse: false, syncScroll: false });
    expect(parseDiffOptions({ ignore: "bogus", highlight: 3, collapse: "x" })).toEqual(DEFAULT_DIFF_OPTIONS);
  });

  it("ignore whitespace policies", () => {
    const a = "fn main() {\n  let x = 1;\n}\n";
    const indented = "fn main() {\n    let x = 1;   \n}\n";
    const inner = "fn main() {\n  let x=1;\n}\n";
    const blank = "fn main() {\n\n  let x = 1;\n}\n";
    expect(chunks(a, indented, "none")).toHaveLength(1);
    expect(chunks(a, indented, "trim")).toHaveLength(0);
    expect(chunks(a, inner, "trim")).toHaveLength(1);
    expect(chunks(a, inner, "whitespace")).toHaveLength(0);
    expect(chunks(a, blank, "whitespace")).toHaveLength(1);
    expect(chunks(a, blank, "whitespaceAndLines")).toHaveLength(0);
  });

  it("keeps real changes (with word-level ranges) when ignoring whitespace", () => {
    const a = "x\nlet total = compute(first);\ny\n";
    const b = "x\n   let total = compute(second);\ny\n";
    const [c, ...rest] = chunks(a, b, "whitespace");
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ fromA: 2, fromB: 2 });
    // Inner changes are character-precise, not whole lines.
    expect(c!.changes.every((ch) => ch.toB - ch.fromB < 20)).toBe(true);
  });

  it("transfers a chunk between sides (>> / << / Revert)", () => {
    const a = doc("x\nold\ny\n");
    const b = doc("x\nnew\nnewer\ny\n");
    const [c] = Chunk.build(a, b);
    const toB = transferChunk(c!, "a", a, b);
    expect(b.replace(toB.from, toB.to, Text.of(toB.insert.split("\n"))).toString()).toBe("x\nold\ny\n");
    const toA = transferChunk(c!, "b", b, a);
    expect(a.replace(toA.from, toA.to, Text.of(toA.insert.split("\n"))).toString()).toBe("x\nnew\nnewer\ny\n");
  });

  it("applies chunks in a merge view through the arrow controls", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let mv: MergeView | null = null;
    mv = new MergeView({
      a: { doc: "1\nleft\n3\n" },
      b: { doc: "1\nright\n3\n" },
      parent,
      revertControls: "a-to-b",
      renderRevertControl: arrowControls(() => mv, { toA: true, toB: true }),
    });
    const holder = arrowControls(() => mv, { toA: true, toB: true })();
    expect([...holder.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      expect.stringContaining("right"),
      expect.stringContaining("left"),
    ]);
    // "<<": the right side's text replaces the left chunk.
    holder.dataset.chunk = "0";
    holder.querySelectorAll("button")[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(mv.a.state.doc.toString()).toBe("1\nright\n3\n");
    expect(mv.chunks).toHaveLength(0);
    mv.a.dispatch({ changes: { from: 2, to: 7, insert: "LEFT" } });
    applyChunk(mv, 0, "a");
    expect(mv.b.state.doc.toString()).toBe("1\nLEFT\n3\n");
    mv.destroy();
    parent.remove();
  });
});

describe("compare entry points", () => {
  it("Compare Files makes both sides live files", () => {
    const data = compareFilesData("/p/a.ts", "/p/b.ts");
    expect(sideFile(data.left, data.path)).toBe("/p/a.ts");
    expect(sideFile(data.right, data.path)).toBe("/p/b.ts");
    expect(diffTitle(data)).toBe("a.ts ↔ b.ts");
  });

  it("Compare with Clipboard: the file, or the selection", () => {
    const whole = clipboardDiffData("/p/a.ts", "clip", null);
    expect(whole.left).toEqual({ type: "text", text: "clip", label: "Clipboard" });
    expect(sideFile(whole.right, whole.path)).toBe("/p/a.ts");
    const sel = clipboardDiffData("/p/a.ts", "clip", "sel");
    expect(sideFile(sel.right, sel.path)).toBeNull();
    expect(diffTitle(sel)).toBe("Clipboard ↔ a.ts (selection)");
  });

  it("text sides get distinct tabs per content; compareTexts arguments are validated", () => {
    const k1 = sideKey({ type: "text", text: "a", label: "Original" });
    const k2 = sideKey({ type: "text", text: "b", label: "Original" });
    expect(k1).not.toBe(k2);
    expect(parseTextsArg({ path: "/p/a", left: { text: "1", label: "L" }, right: { text: "2", label: "R" } })).toMatchObject({
      path: "/p/a",
    });
    expect(parseTextsArg({ path: "/p/a", left: { text: 1 } })).toBeNull();
    expect(diffInput(compareFilesData("/p/a", "/p/b")).key).toContain("file:/p/a");
  });
});
