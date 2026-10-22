import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { CompletionContext } from "@codemirror/autocomplete";
import {
  expandLiveTemplateAtCaret,
  expandPostfixAtCaret,
  surroundWith,
  templateCompletionSource,
  templateEditorExtension,
} from "../editor";
import { closeChooser, useChooser } from "../popup/store";

const MODES: Record<string, string> = { typescript: "TypeScript", rust: "Rust", python: "Python", java: "Java" };

// jsdom has no layout; CodeMirror measures ranges when scrolling the caret into view.
const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= rects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  closeChooser();
});

async function editor(language: string, doc: string, cursor = doc.length) {
  const support = await languages.find((l) => l.name === MODES[language])!.load();
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      support,
      EditorState.allowMultipleSelections.of(true),
      templateEditorExtension({
        doc: 1,
        path: `/p/src/Main.${language}`,
        language,
        uiMode: MODES[language]!,
        readOnly: false,
      }),
    ],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  view = new EditorView({ state, parent: document.body });
  return view;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const tab = (v: EditorView) => runScopeHandlers(v, new KeyboardEvent("keydown", { key: "Tab" }), "editor");

describe("Tab expansion", () => {
  it("expands a live template abbreviation", async () => {
    const v = await editor("typescript", "function f() {\n  log");
    expect(tab(v)).toBe(true);
    await tick();
    expect(v.state.doc.toString()).toBe("function f() {\n  console.log();");
    expect(v.state.selection.main.head).toBe("function f() {\n  console.log(".length);
  });

  it("falls through when nothing matches", async () => {
    const v = await editor("typescript", "zzz");
    expect(expandLiveTemplateAtCaret(v)).toBe(false);
  });

  it("does not expand code templates inside comments", async () => {
    const v = await editor("typescript", "// log");
    expect(expandLiveTemplateAtCaret(v)).toBe(false);
  });

  it("expands todo with the language's comment start", async () => {
    const v = await editor("python", "x = 1\ntodo");
    expect(expandLiveTemplateAtCaret(v)).toBe(true);
    await tick();
    expect(v.state.doc.toString()).toBe("x = 1\n# TODO: ");
  });

  it("expands postfix templates replacing the expression", async () => {
    const v = await editor("rust", "fn main() {\n    items.iter().for");
    expect(expandPostfixAtCaret(v)).toBe(true);
    await tick();
    expect(v.state.doc.toString()).toBe("fn main() {\n    for item in items.iter() {\n      \n    }");
  });

  it("wraps compound expressions for .not and offers a chooser", async () => {
    const v = await editor("java", "class A { void f() { boolean b = x > y.not");
    expect(expandPostfixAtCaret(v)).toBe(true);
    const req = useChooser.getState().request!;
    expect(req.items.map((i) => i.label)).toEqual(["y", "x > y"]);
    req.onPick(req.items[1]!, "");
    await tick();
    expect(v.state.doc.toString()).toBe("class A { void f() { boolean b = !(x > y)");
  });
});

describe("surround with", () => {
  it("wraps the selected lines", async () => {
    const doc = "def f():\n    a()\n    b()\n";
    const v = await editor("python", doc);
    v.dispatch({ selection: EditorSelection.range(doc.indexOf("a()"), doc.indexOf("b()") + 3) });
    surroundWith(v);
    const req = useChooser.getState().request!;
    req.onPick(
      req.items.find((i) => i.label === "if")!,
      "",
    );
    await tick();
    expect(v.state.doc.toString()).toBe("def f():\n    if :\n      a()\n      b()\n    \n");
  });
});

describe("completion source", () => {
  it("offers postfix templates after a dot", async () => {
    const v = await editor("typescript", "items.");
    const r = await templateCompletionSource(new CompletionContext(v.state, v.state.doc.length, false));
    expect(r?.from).toBe(6);
    expect(r?.options.map((o) => o.label)).toContain("for");
  });

  it("offers live templates for a word", async () => {
    const v = await editor("typescript", "lo");
    const r = await templateCompletionSource(new CompletionContext(v.state, 2, false));
    expect(r?.options.map((o) => o.label)).toContain("log");
  });
});
