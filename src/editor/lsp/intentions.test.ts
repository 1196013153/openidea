import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeAction } from "@/bindings";

const resolved: CodeAction = {
  title: "Introduce local variable",
  kind: "refactor.extract",
  isPreferred: false,
  disabledReason: null,
  edit: {
    files: [
      {
        kind: "edit",
        path: "/p/a.ts",
        edits: [{ range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, new_text: "const x = 1;\n" }],
      },
      { kind: "create", path: "/p/b.ts", overwrite: false },
    ],
  },
  command: null,
  data: null,
  server: 1,
};
const lspResolveCodeAction = vi.fn(async () => ({ status: "ok" as const, data: resolved }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspResolveCodeAction } };
});

const { intentionPreview } = await import("./intentions");
const { lspDoc } = await import("./lsp");

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.clearAllMocks();
});

describe("intention preview", () => {
  it("resolves the action once and shows its diff for this file", async () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "f(1);",
        extensions: [lspDoc.of({ doc: 1, path: "/p/a.ts", language: "typescript", uiMode: null, readOnly: false })],
      }),
    });
    views.push(view);
    const action = { ...resolved, edit: null };
    const cache = new Map<CodeAction, Promise<CodeAction>>();
    const signal = new AbortController().signal;
    const preview = await intentionPreview(view, action, cache, signal);
    expect(preview).toEqual({
      kind: "diff",
      lines: [
        { kind: "added", text: "const x = 1;" },
        { kind: "context", text: "f(1);" },
      ],
      note: "Also changes 1 other file",
    });
    await intentionPreview(view, action, cache, signal);
    expect(lspResolveCodeAction).toHaveBeenCalledOnce();
  });
});
