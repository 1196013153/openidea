import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeAction, CodeActionQuery } from "@/bindings";

type Result = { status: "ok"; data: unknown } | { status: "error"; error: { kind: string; message: string } };
const ok = (data: unknown): Result => ({ status: "ok", data });
const unavailable: Result = { status: "error", error: { kind: "unavailable", message: "no server" } };

let query: (request: number) => Promise<Result> = async () => ok({ actions: [], advertisedKinds: null });
let prepare: Result = ok(null);
const lspCodeActionQuery = vi.fn(async (request: number, _doc: number, _range: unknown, _only: string[]) => query(request));
const lspPrepareRename = vi.fn(async () => prepare);
const lspApplyCodeAction = vi.fn(async () => ok(null));
const lspCodeActions = vi.fn(async () => ok([]));
const cancelRequest = vi.fn(async () => undefined);
const languages = vi.fn(async () => [{ id: "rust", name: "Rust", lineComment: "//", blockComment: ["/*", "*/"] }]);

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, lspCodeActionQuery, lspPrepareRename, lspApplyCodeAction, lspCodeActions, cancelRequest, languages },
  };
});
let expression = false;
vi.mock("@/editor/structure", () => ({
  structure: {
    support: vi.fn(async () => ({ tree: true, locals: false })),
    expressionAt: vi.fn(async () => ({ expression: expression ? { kind: "call_expression" } : null })),
  },
}));
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));
const introduceFallback = vi.fn(async () => true);
vi.mock("./introduce", () => ({ introduceFallback }));
const safeDelete = vi.fn();
vi.mock("./safeDelete", () => ({ safeDelete }));

const { classifyAction, kindAdvertised, cannotPerform } = await import("./catalog");
const { refactorThis, runRefactoring } = await import("./refactorThis");
const { useLspPopup, closePopup } = await import("@/editor/lsp/popupStore");
const { lspDoc } = await import("@/editor/lsp/lsp");

// jsdom has no layout; popups anchor at the caret.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const action = (title: string, kind: string, disabledReason: string | null = null): CodeAction => ({
  title,
  kind,
  isPreferred: false,
  disabledReason,
  edit: null,
  command: null,
  data: null,
  server: 1,
});
const answer = (actions: CodeAction[], advertisedKinds: string[] | null = null) => async () =>
  ok({ actions, advertisedKinds } satisfies CodeActionQuery);

let view: EditorView | null = null;
function editor(text = "fn main() { let total = price * 2; }") {
  view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: text.indexOf("price") + 1 },
      extensions: [lspDoc.of({ doc: 1, path: "/p/a.rs", language: "rust", uiMode: null, readOnly: false })],
    }),
  });
  return view;
}
const labels = () => {
  const p = useLspPopup.getState().popup;
  return p?.kind === "list" ? p.items.map((i) => i.label) : null;
};

beforeEach(() => {
  query = answer([]);
  prepare = ok(null);
  expression = false;
});
afterEach(() => {
  view?.destroy();
  view = null;
  closePopup();
  vi.clearAllMocks();
});

describe("catalog", () => {
  it("maps server kinds and titles to IDEA refactorings", () => {
    const c = (title: string, kind: string | null) => classifyAction({ title, kind });
    expect(c("Extract to function in module scope", "refactor.extract.function")).toBe("extractMethod");
    expect(c("Extract into function", "refactor.extract")).toBe("extractMethod");
    expect(c("Extract into variable", "refactor.extract")).toBe("extractVariable");
    expect(c("Extract to constant in enclosing scope", "refactor.extract.constant")).toBe("extractVariable");
    expect(c("Extract to constant in module scope", "refactor.extract.constant")).toBe("extractConstant");
    expect(c("Extract field", "refactor.extract.field")).toBe("extractField");
    expect(c("Introduce parameter", "refactor.extract.parameter")).toBe("extractParameter");
    expect(c("Inline variable", "refactor.inline")).toBe("inline");
    expect(c("Move to a new file", "refactor.move.newFile")).toBe("move");
    expect(c("Change signature", "refactor.changeSignature")).toBe("changeSignature");
    expect(c("Convert parameters to destructured object", "refactor.rewrite.parameters.toDestructured")).toBeNull();
    expect(c("Extract type alias", "refactor.extract.type")).toBeNull();
    expect(c("Remove unused", "quickfix")).toBeNull();
    // typescript-language-server reports plain `refactor` for everything.
    expect(c("Extract to inner function in function 'formatMoney'", "refactor")).toBe("extractMethod");
    expect(c("Extract to constant in enclosing scope", "refactor")).toBe("extractVariable");
    expect(c("Extract to type alias", "refactor")).toBeNull();
    expect(c("Extract type as type alias", "refactor.extract")).toBeNull();
    expect(c("Extract struct from enum variant", "refactor.extract")).toBeNull();
    expect(c("Move to a new file", "refactor")).toBe("move");
    expect(c("Inline variable", "refactor")).toBe("inline");
    expect(c("Convert to template string", "refactor")).toBeNull();
  });

  it("knows which kinds an advertised list can produce", () => {
    expect(kindAdvertised(null, "refactor.move")).toBe(true);
    expect(kindAdvertised(["quickfix", "refactor.extract"], "refactor.move")).toBe(false);
    expect(kindAdvertised(["", "quickfix"], "refactor.move")).toBe(false);
    expect(kindAdvertised(["refactor"], "refactor.move")).toBe(true);
    expect(kindAdvertised(["refactor.move.newFile"], "refactor.move")).toBe(true);
  });

  it("formats IDEA's hint", () => {
    expect(cannotPerform("Caret should be on a symbol.")).toBe("Cannot perform refactoring. Caret should be on a symbol");
  });
});

describe("Refactor This", () => {
  it("lists only the refactorings applicable at the caret, in IDEA order", async () => {
    prepare = ok({ start: { line: 0, col: 0 }, end: { line: 0, col: 1 } });
    query = answer([
      action("Inline variable", "refactor.inline"),
      action("Extract into variable", "refactor.extract"),
      action("Convert to raw string", "refactor.rewrite"),
      action("Extract into function", "refactor.extract", "Can't extract here"),
    ]);
    await refactorThis(editor(), vi.fn());
    expect(labels()).toEqual(["Rename…", "Safe Delete…", "Introduce Variable…", "Inline…", "Convert to raw string"]);
    expect(lspCodeActionQuery).toHaveBeenCalledOnce();
    expect(lspCodeActionQuery.mock.calls[0]![3]).toEqual(["refactor"]);
  });

  it("runs the mapped server action, Rename and Safe Delete", async () => {
    prepare = ok({ start: { line: 0, col: 0 }, end: { line: 0, col: 1 } });
    query = answer([action("Inline variable", "refactor.inline")]);
    const rename = vi.fn();
    const v = editor();
    await refactorThis(v, rename);
    const items = (useLspPopup.getState().popup as { items: { label: string; run: () => void }[] }).items;
    items.find((i) => i.label === "Inline…")!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(lspApplyCodeAction).toHaveBeenCalledOnce();
    items.find((i) => i.label === "Rename…")!.run();
    expect(rename).toHaveBeenCalledWith(v);
    items.find((i) => i.label === "Safe Delete…")!.run();
    expect(safeDelete).toHaveBeenCalledWith(v);
  });

  it("offers the syntax-based Introduce Variable / Constant when the server is down and an expression is there", async () => {
    query = async () => unavailable;
    expression = true;
    await refactorThis(editor(), vi.fn());
    expect(labels()).toEqual(["Introduce Variable…", "Introduce Constant…"]);
  });

  it("says so when nothing applies", async () => {
    const v = editor();
    await refactorThis(v, vi.fn());
    expect(useLspPopup.getState().popup).toBeNull();
    expect(showHint).toHaveBeenCalledWith(v, "No refactorings available at the caret");
  });

  it("cancels a superseded query and drops answers after the caret moved", async () => {
    let release: (r: Result) => void = () => {};
    query = (request) => new Promise((r) => (release = r)).then((x) => (void request, x as Result));
    const v = editor();
    const first = refactorThis(v, vi.fn());
    await new Promise((r) => setTimeout(r, 0));
    const firstId = lspCodeActionQuery.mock.calls[0]![0];
    const releaseFirst = release;
    query = answer([action("Inline variable", "refactor.inline")]);
    v.dispatch({ selection: { anchor: 2 } });
    const second = refactorThis(v, vi.fn());
    expect(cancelRequest).toHaveBeenCalledWith(firstId);
    releaseFirst({ status: "error", error: { kind: "cancelled", message: "cancelled" } });
    await Promise.all([first, second]);
    expect(labels()).toEqual(["Inline…"]);

    closePopup();
    let late: (r: Result) => void = () => {};
    query = () => new Promise((r) => (late = r));
    const third = refactorThis(v, vi.fn());
    await new Promise((r) => setTimeout(r, 0));
    v.dispatch({ selection: { anchor: 5 } });
    late(ok({ actions: [action("Inline variable", "refactor.inline")], advertisedKinds: null }));
    await third;
    expect(useLspPopup.getState().popup).toBeNull();
  });
});

describe("Refactor menu actions", () => {
  it("apply the single matching action, or offer a choice", async () => {
    query = answer([action("Move to a new file", "refactor.move.newFile")]);
    await runRefactoring(editor(), "move");
    expect(lspApplyCodeAction).toHaveBeenCalledOnce();
    expect(lspCodeActionQuery.mock.calls[0]![3]).toEqual(["refactor.move"]);

    closePopup();
    query = answer([action("Inline variable", "refactor.inline"), action("Inline call", "refactor.inline.call")]);
    await runRefactoring(view!, "inline");
    expect(labels()).toEqual(["Inline variable", "Inline call"]);
  });

  it("say the server doesn't support it when its advertised kinds can't produce it", async () => {
    query = answer([], ["quickfix", "refactor.extract", "refactor.inline"]);
    const v = editor();
    await runRefactoring(v, "move");
    expect(showHint).toHaveBeenCalledWith(v, "Cannot perform refactoring. The language server for Rust doesn't support Move");
  });

  it("give IDEA's caret reason, the server's disabled reason, or the missing server", async () => {
    const v = editor();
    await runRefactoring(v, "inline");
    expect(showHint).toHaveBeenLastCalledWith(
      v,
      "Cannot perform refactoring. Caret should be positioned at the name of the element to be refactored",
    );
    query = answer([action("Extract into function", "refactor.extract", "Selection is not a statement")]);
    await runRefactoring(v, "extractMethod");
    expect(showHint).toHaveBeenLastCalledWith(v, "Cannot perform refactoring. Selection is not a statement");
    query = async () => unavailable;
    await runRefactoring(v, "changeSignature");
    expect(showHint).toHaveBeenLastCalledWith(v, "Cannot perform refactoring. No language server for Rust is running");
  });

  it("Introduce Variable falls back to the syntax refactoring", async () => {
    query = async () => unavailable;
    const v = editor();
    await runRefactoring(v, "extractVariable");
    expect(introduceFallback).toHaveBeenCalledWith(v, "variable", "notReady");
    expect(showHint).not.toHaveBeenCalled();
  });

  it("never fall back to unrelated code actions", async () => {
    await runRefactoring(editor(), "extractField");
    expect(lspCodeActions).not.toHaveBeenCalled();
  });
});
