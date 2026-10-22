import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { closeBrackets } from "@codemirror/autocomplete";

const help = { signatures: [{ label: "f(a: number)", documentation: null, parameters: [[2, 11]] }], activeSignature: 0, activeParameter: 0 };
const lspSignatureHelp = vi.fn(async () => ({ status: "ok" as const, data: help }));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspSignatureHelp } };
});

const { signatureExtension, acceptsParameter } = await import("./signature");
const { lspDoc } = await import("./lsp");

// jsdom has no layout; CodeMirror measures text when the tooltip is positioned.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  lspSignatureHelp.mockClear();
});

function typeChar(view: EditorView, ch: string) {
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert))) view.dispatch(insert());
}

describe("parameter info auto-popup", () => {
  it("opens after typing `(` even when the closing paren is auto-inserted", async () => {
    vi.useFakeTimers();
    try {
      const view = new EditorView({
        state: EditorState.create({
          doc: "f",
          selection: { anchor: 1 },
          extensions: [closeBrackets(), lspDoc.of({ doc: 1, path: "/a.ts", language: "typescript", uiMode: null, readOnly: false }), signatureExtension()],
        }),
        parent: document.body,
      });
      views.push(view);
      typeChar(view, "(");
      expect(view.state.doc.toString()).toBe("f()");
      await vi.advanceTimersByTimeAsync(1000);
      expect(lspSignatureHelp).toHaveBeenCalledTimes(1);
      expect(view.dom.querySelector(".cm-lsp-signature b")?.textContent).toBe("a: number");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("acceptsParameter", () => {
  it("rejects overloads with too few parameters unless the last is variadic", () => {
    expect(acceptsParameter({ label: "println() : void", parameters: [] }, 0)).toBe(false);
    expect(acceptsParameter({ label: "println(Object x) : void", parameters: [[8, 16]] }, 0)).toBe(true);
    expect(acceptsParameter({ label: "println(Object x) : void", parameters: [[8, 16]] }, 1)).toBe(false);
    expect(acceptsParameter({ label: "format(String f, Object... a)", parameters: [[7, 15], [17, 28]] }, 4)).toBe(true);
  });
});
