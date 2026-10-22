import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CompletionItem } from "@/bindings";
import { completionSymbolKind, identifierEnd, toCmCompletion, triggerCharacter } from "./completionItems";
import { applyLspCompletion, makeCompletion } from "./completion";

function item(over: Partial<CompletionItem> = {}): CompletionItem {
  return {
    label: "create",
    labelDetail: null,
    detail: null,
    kind: "method",
    documentation: null,
    sortText: null,
    filterText: null,
    preselect: false,
    deprecated: false,
    insertText: "create",
    isSnippet: false,
    replaceRange: null,
    replaceRangeTab: null,
    additionalEdits: [],
    commitCharacters: [],
    command: null,
    data: null,
    server: 1,
    ...over,
  };
}

describe("toCmCompletion", () => {
  it("maps label, detail, kind and sort text", () => {
    const c = toCmCompletion(
      item({ labelDetail: "(req: CreateOrderRequest)", detail: "Order", sortText: "0001", commitCharacters: ["("] }),
    );
    expect(c).toMatchObject({
      label: "create",
      detail: "(req: CreateOrderRequest)",
      type: "method",
      sortText: "0001",
      commitCharacters: ["("],
    });
    expect(c.displayLabel).toBeUndefined();
    expect(c.boost).toBeUndefined();
  });

  it("filters on filterText while displaying the label", () => {
    const c = toCmCompletion(item({ label: "@GetMapping", filterText: "GetMapping" }));
    expect(c.label).toBe("GetMapping");
    expect(c.displayLabel).toBe("@GetMapping");
  });

  it("boosts preselected and demotes deprecated items", () => {
    expect(toCmCompletion(item({ preselect: true })).boost).toBe(99);
    expect(toCmCompletion(item({ deprecated: true })).boost).toBeLessThan(0);
  });

  it("maps completion kinds to symbol badges", () => {
    expect(completionSymbolKind("function")).toBe("function");
    expect(completionSymbolKind("enumMember")).toBe("constant");
    expect(completionSymbolKind("typeParameter")).toBe("type");
    expect(completionSymbolKind(null)).toBe("text");
  });
});

describe("completion helpers", () => {
  it("detects trigger characters", () => {
    expect(triggerCharacter("a.")).toBe(".");
    expect(triggerCharacter("..")).toBeNull();
    expect(triggerCharacter("a::")).toBe(":");
    expect(triggerCharacter("a:")).toBeNull();
    expect(triggerCharacter("a->")).toBe(">");
    expect(triggerCharacter("a>")).toBeNull();
    expect(triggerCharacter(" @")).toBe("@");
    expect(triggerCharacter("ab")).toBeNull();
  });

  it("finds identifier ends", () => {
    expect(identifierEnd("foo.barBaz(1)", 4)).toBe(10);
    expect(identifierEnd("x ", 1)).toBe(1);
  });
});

describe("applying completions", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  /** `|` marks the caret where completion was requested; `typed` is typed afterwards. */
  function setup(text: string, typed = "") {
    const pos = text.indexOf("|");
    const doc = text.replace("|", "");
    const state = EditorState.create({ doc, selection: { anchor: pos } });
    view = new EditorView({ state, parent: document.body });
    const req = { doc: 1, path: "/p/a.ts", language: null, pos, text: view.state.doc };
    if (typed) view.dispatch({ changes: { from: pos, insert: typed }, selection: { anchor: pos + typed.length } });
    return { view, req, pos };
  }

  const apply = (v: EditorView, c: ReturnType<typeof makeCompletion>, from: number) =>
    (c.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(v, c, from, v.state.selection.main.head);

  it("inserts over the typed prefix and keeps text after the caret (↵)", () => {
    const { view, req } = setup("service.cr|Order()");
    apply(view, makeCompletion(item({ insertText: "create" }), req), 8);
    expect(view.state.doc.toString()).toBe("service.createOrder()");
    expect(view.state.selection.main.head).toBe(14);
  });

  it("replaces the rest of the identifier with ⇥", () => {
    const { view, req } = setup("service.cr|Order()");
    applyLspCompletion(view, makeCompletion(item({ insertText: "create" }), req), 8, 10, "replace");
    expect(view.state.doc.toString()).toBe("service.create()");
  });

  it("uses the server's ⇥ range when given", () => {
    const { view, req } = setup("a.cr|Order.x");
    const c = makeCompletion(
      item({
        insertText: "create",
        replaceRange: { start: { line: 0, col: 2 }, end: { line: 0, col: 4 } },
        replaceRangeTab: { start: { line: 0, col: 2 }, end: { line: 0, col: 9 } },
      }),
      req,
    );
    applyLspCompletion(view, c, 2, 4, "replace");
    expect(view.state.doc.toString()).toBe("a.create.x");
  });

  it("honours the server's replace range shifted by text typed since the request", () => {
    const { view, req } = setup("x.c|", "re");
    const c = makeCompletion(
      item({ insertText: "create()", replaceRange: { start: { line: 0, col: 2 }, end: { line: 0, col: 3 } } }),
      req,
    );
    apply(view, c, 2);
    expect(view.state.doc.toString()).toBe("x.create()");
  });

  it("applies additional edits (imports) in the same change", () => {
    const { view, req } = setup("\nfoo.ba|");
    const c = makeCompletion(
      item({
        insertText: "bar",
        additionalEdits: [{ range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, new_text: "import bar;" }],
      }),
      req,
    );
    apply(view, c, 5);
    expect(view.state.doc.toString()).toBe("import bar;\nfoo.bar");
  });

  it("expands snippets with fields", () => {
    const { view, req } = setup("pri|");
    apply(view, makeCompletion(item({ insertText: "println!(${1:arg})$0", isSnippet: true }), req), 0);
    expect(view.state.doc.toString()).toBe("println!(arg)");
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("arg");
  });
});
