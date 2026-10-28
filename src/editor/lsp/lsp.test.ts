import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, documentSynced, type EditorDocContext } from "@/editor/api";

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true };
});

const { lspRequest } = await import("./lsp");

describe("lspRequest", () => {
  it("waits until open editors' edits reached the backend", async () => {
    let synced!: () => void;
    const pending = new Promise<void>((r) => (synced = r));
    const view = new EditorView({ state: EditorState.create({ extensions: documentSynced.of(() => pending) }) });
    const handle = { view, ctx: {} as EditorDocContext };
    _addEditor(handle);
    const run = vi.fn(async () => ({ status: "ok" as const, data: 1 }));
    const result = lspRequest(run);
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    synced();
    expect(await result).toBe(1);
    _removeEditor(handle);
    view.destroy();
  });
});
