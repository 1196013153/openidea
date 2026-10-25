import { afterEach, describe, expect, it } from "vitest";
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editCommand } from "../appActions";

describe("Edit menu Undo / Redo", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("use the focused editor's history, including programmatic edits", () => {
    view = new EditorView({ state: EditorState.create({ doc: "a", extensions: history() }), parent: document.body });
    view.dispatch({ changes: { from: 1, insert: "b" }, userEvent: "input.complete" });
    view.contentDOM.focus();
    editCommand("undo")();
    expect(view.state.doc.toString()).toBe("a");
    editCommand("redo")();
    expect(view.state.doc.toString()).toBe("ab");
  });
});
