/**
 * Reformat Code (⌥⌘L): `lsp_format` for the selection (or the whole file),
 * applied locally as one CodeMirror transaction and one undo step; editor/core
 * syncs it to the backend like any user edit.
 */
import { indentUnit } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { commands } from "@/platform/ipc";
import { CONTRIBUTED_FORMAT, contributedAt, whenSynced, type ContributedFormatter } from "@/editor/api";
import { docOf, lspRequest, reportLspError } from "./lsp";
import { offsetToPos, textEditsToChanges } from "./positions";
import { showHint } from "./hint";

export interface FormatResult {
  applied: boolean;
  /** Number of changed regions. */
  changes: number;
}

export async function formatDocument(view: EditorView, opts: { explicit: boolean; selectionOnly?: boolean } = { explicit: true }): Promise<FormatResult> {
  const own = contributedAt<ContributedFormatter>(view.state, CONTRIBUTED_FORMAT, 0);
  if (own) return applyContributedFormat(view, own, opts);
  const doc = docOf(view);
  if (!doc || doc.readOnly) return { applied: false, changes: 0 };
  // The server formats the backend's copy: let pending keystrokes reach it first.
  await whenSynced(view);
  const state = view.state;
  const sel = state.selection.main;
  const useSelection = (opts.selectionOnly ?? true) && !sel.empty;
  const range = useSelection ? { start: offsetToPos(state.doc, sel.from), end: offsetToPos(state.doc, sel.to) } : null;
  const options = { tabSize: state.tabSize, insertSpaces: !state.facet(indentUnit).includes("\t") };
  let edits;
  try {
    edits = await lspRequest(() => commands.lspFormat(doc.doc, range, options));
  } catch (e) {
    reportLspError(view, e, opts.explicit);
    return { applied: false, changes: 0 };
  }
  if (view.state.doc !== state.doc) {
    if (opts.explicit) showHint(view, "The file changed while formatting; try again");
    return { applied: false, changes: 0 };
  }
  const changes = textEditsToChanges(state.doc, edits);
  if (!changes.length) {
    if (opts.explicit) showHint(view, useSelection ? "The selection is already formatted" : "The code is already formatted");
    return { applied: false, changes: 0 };
  }
  view.dispatch({
    changes,
    userEvent: "format",
    annotations: isolateHistory.of("full"),
    scrollIntoView: false,
  });
  return { applied: true, changes: changes.length };
}

function applyContributedFormat(
  view: EditorView,
  format: ContributedFormatter,
  opts: { explicit: boolean; selectionOnly?: boolean },
): FormatResult {
  const state = view.state;
  if (state.readOnly) return { applied: false, changes: 0 };
  const sel = state.selection.main;
  const useSelection = (opts.selectionOnly ?? true) && !sel.empty;
  const changes = format(state, useSelection ? { from: sel.from, to: sel.to } : null).filter(
    (c) => state.sliceDoc(c.from, c.to) !== c.insert,
  );
  if (!changes.length) {
    if (opts.explicit) showHint(view, useSelection ? "The selection is already formatted" : "The code is already formatted");
    return { applied: false, changes: 0 };
  }
  view.dispatch({ changes, userEvent: "format", annotations: isolateHistory.of("full"), scrollIntoView: false });
  return { applied: true, changes: changes.length };
}
