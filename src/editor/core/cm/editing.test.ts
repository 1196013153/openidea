import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentService, indentUnit } from "@codemirror/language";
import {
  addCaretsToLineEnds,
  commentLine,
  joinLines,
  startNewLine,
  startNewLineBefore,
  toggleCase,
  unselectOccurrence,
} from "./editing";
import { toggleCaret } from "./multiCaret";

/** Brace languages in miniature: one unit deeper after a line ending in `{`. */
const javascript = () =>
  indentService.of((cx, pos) => {
    const line = cx.lineAt(pos, -1);
    const base = /^ */.exec(line.text)![0].length;
    const before = line.text.slice(0, pos - line.from).trimEnd();
    return before.endsWith("{") ? base + 2 : base;
  });

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** `|` marks carets, `[`/`]` a selection. */
function make(text: string, extensions: Extension = []) {
  const ranges: ReturnType<typeof EditorSelection.cursor>[] = [];
  let doc = "";
  let anchor = -1;
  for (const ch of text) {
    if (ch === "|") ranges.push(EditorSelection.cursor(doc.length));
    else if (ch === "[") anchor = doc.length;
    else if (ch === "]") ranges.push(EditorSelection.range(anchor, doc.length));
    else doc += ch;
  }
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
      extensions: [EditorState.allowMultipleSelections.of(true), indentUnit.of("  "), extensions],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function show(view: EditorView): string {
  const { doc, selection } = view.state;
  let out = doc.toString();
  for (const r of [...selection.ranges].sort((a, b) => b.from - a.from))
    out = r.empty ? out.slice(0, r.head) + "|" + out.slice(r.head) : out.slice(0, r.from) + "[" + out.slice(r.from, r.to) + "]" + out.slice(r.to);
  return out;
}

describe("start new line", () => {
  it("opens an indented line below, wherever the caret is", () => {
    const v = make("function f() {\n  let a| = 1;\n}", javascript());
    startNewLine(v);
    expect(show(v)).toBe("function f() {\n  let a = 1;\n  |\n}");
  });

  it("indents after a block opener", () => {
    const v = make("if (x) {|", javascript());
    startNewLine(v);
    expect(show(v)).toBe("if (x) {\n  |");
  });

  it("opens a line above, keeping the indent", () => {
    const v = make("a\n  b|c\n");
    startNewLineBefore(v);
    expect(show(v)).toBe("a\n  |\n  bc\n");
  });

  it("opens a line above the first line", () => {
    const v = make("  x|y");
    startNewLineBefore(v);
    expect(show(v)).toBe("  |\n  xy");
  });
});

describe("join lines", () => {
  it("joins the next line with one space, dropping its indent", () => {
    const v = make("let a =| \n    1;\n");
    joinLines(v);
    expect(show(v)).toBe("let a =| 1;\n");
  });

  it("joins every selected line", () => {
    const v = make("[a\n  b\n  c]\nd");
    joinLines(v);
    expect(v.state.doc.toString()).toBe("a b c\nd");
  });

  it("merges consecutive line comments and keeps brackets tight", () => {
    expect((() => { const v = make("// one|\n// two"); joinLines(v); return v.state.doc.toString(); })()).toBe("// one two");
    expect((() => { const v = make("f(|\n  x\n)"); joinLines(v); joinLines(v); return v.state.doc.toString(); })()).toBe("f(x)");
  });

  it("does nothing on the last line", () => {
    const v = make("a|");
    joinLines(v);
    expect(show(v)).toBe("a|");
  });
});

describe("toggle case", () => {
  it("upper-cases mixed text and lower-cases upper-case text", () => {
    const v = make("[fooBar]");
    toggleCase(v);
    expect(v.state.doc.toString()).toBe("FOOBAR");
    toggleCase(v);
    expect(v.state.doc.toString()).toBe("foobar");
  });

  it("uses the word at the caret without a selection", () => {
    const v = make("one tw|o three");
    toggleCase(v);
    expect(show(v)).toBe("one TW|O three");
  });
});

describe("multiple carets", () => {
  it("adds carets at the ends of the selected lines", () => {
    const v = make("[ab\ncd\nef]\ngh");
    addCaretsToLineEnds(v);
    expect(show(v)).toBe("ab|\ncd|\nef|\ngh");
  });

  it("ignores the line the selection ends at column 0 of", () => {
    const v = make("[ab\ncd\n]ef");
    addCaretsToLineEnds(v);
    expect(show(v)).toBe("ab|\ncd|\nef");
  });

  it("unselects the most recent occurrence", () => {
    const v = make("[a] [a] [a]");
    v.dispatch({ selection: EditorSelection.create(v.state.selection.ranges, 2) });
    unselectOccurrence(v);
    expect(show(v)).toBe("[a] [a] a");
    expect(v.state.selection.mainIndex).toBe(1);
    unselectOccurrence(v);
    expect(unselectOccurrence(v)).toBe(false);
  });

  it("⌥⇧click toggles a caret", () => {
    const start = EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(5)]);
    expect(toggleCaret(start, 3, 3).ranges.map((r) => r.head)).toEqual([1, 3, 5]);
    expect(toggleCaret(start, 5, 5).ranges.map((r) => r.head)).toEqual([1]);
    expect(toggleCaret(EditorSelection.single(2), 2, 2).ranges.map((r) => r.head)).toEqual([2]);
    expect(toggleCaret(EditorSelection.single(0), 2, 4).ranges.map((r) => [r.from, r.to])).toEqual([[0, 0], [2, 4]]);
  });
});

describe("comment with line comment", () => {
  const comments = EditorState.languageData.of(() => [{ commentTokens: { line: "//" } }]);

  it("moves the caret to the next line without a selection", () => {
    const v = make("a|b\ncd\n", comments);
    commentLine(v);
    expect(show(v)).toBe("// ab\nc|d\n");
  });

  it("keeps a selection where it is", () => {
    const v = make("[ab\ncd]\n", comments);
    commentLine(v);
    expect(v.state.doc.toString()).toBe("// ab\n// cd\n");
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(2);
  });
});
