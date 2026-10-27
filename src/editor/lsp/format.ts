/**
 * Reformat Code (⌥⌘L): `lsp_format` for the selection (or the whole file),
 * applied locally as one CodeMirror transaction and one undo step; editor/core
 * syncs it to the backend like any user edit. As in IDEA an explicit reformat
 * reports "Formatted N lines" with a link to the Reformat File dialog
 * (⌥⇧⌘L: scope and Optimize Imports).
 */
import { indentUnit } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { commands } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { executeAction } from "@/platform/actions";
import { formatExcluded, formatGuardOptions, guardFormatChanges, type FormatGuardOptions } from "@/platform/formatGuard";
import { useProject } from "@/platform/project";
import { CONTRIBUTED_FORMAT, contributedAt, whenSynced, type ContributedFormatter } from "@/editor/api";
import { docOf, lspRequest, reportLspError } from "./lsp";
import { offsetToPos, textEditsToChanges } from "./positions";
import { tx, txTemplate } from "@/platform/i18n";
import { showHint } from "./hint";
import { openPopup, type ReformatOptions } from "./popupStore";

export interface FormatResult {
  applied: boolean;
  /** Number of changed regions. */
  changes: number;
  /** Lines of the result that the changes touched. */
  lines: number;
}

const NOTHING: FormatResult = { applied: false, changes: 0, lines: 0 };

/** Lines of the new document touched by `changes` (given against `doc`), as IDEA counts "Formatted N lines". */
export function formattedLines(doc: Text, changes: readonly { from: number; to: number; insert: string }[]): number {
  const touched = new Set<number>();
  // Line shift of the changes so far, to number lines as in the new text.
  let shift = 0;
  for (const c of [...changes].sort((a, b) => a.from - b.from)) {
    const startLine = doc.lineAt(c.from).number + shift;
    const insertedLines = c.insert.split("\n").length - 1;
    for (let n = startLine; n <= startLine + insertedLines; n++) touched.add(n);
    shift += insertedLines - (doc.lineAt(c.to).number - doc.lineAt(c.from).number);
  }
  return touched.size;
}

function formattedHint(view: EditorView, lines: number) {
  const keys = shortcutLabel("code.reformatDialog");
  showHint(view, () => {
    const box = document.createElement("div");
    box.textContent = txTemplate(`Formatted ${lines} ${lines === 1 ? "line" : "lines"}`);
    const more = document.createElement("div");
    const link = document.createElement("button");
    link.type = "button";
    link.className = "cm-lsp-link-button";
    link.textContent = tx("Show");
    link.addEventListener("mousedown", (e) => e.preventDefault());
    link.addEventListener("click", () => void executeAction("code.reformatDialog"));
    more.append(link, `${tx(" the Reformat dialog")}${keys ? `: ${keys}` : ""}`);
    box.appendChild(more);
    return box;
  });
}

export async function formatDocument(
  view: EditorView,
  opts: { explicit: boolean; selectionOnly?: boolean } = { explicit: true },
): Promise<FormatResult> {
  const result = await format(view, opts);
  if (opts.explicit && result.applied) formattedHint(view, result.lines);
  return result;
}

async function format(view: EditorView, opts: { explicit: boolean; selectionOnly?: boolean }): Promise<FormatResult> {
  const { project, settings } = useProject.getState();
  const guard = formatGuardOptions(settings);
  const path = docOf(view)?.path;
  if (path && formatExcluded(path, project?.root ?? null, guard.doNotFormat)) {
    if (opts.explicit) showHint(view, "Formatting is turned off for this file (Code Style › Formatter › Do not format)");
    return NOTHING;
  }
  const own = contributedAt<ContributedFormatter>(view.state, CONTRIBUTED_FORMAT, 0);
  if (own) return applyContributedFormat(view, own, opts, guard);
  const doc = docOf(view);
  if (!doc || doc.readOnly) return NOTHING;
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
    return NOTHING;
  }
  if (view.state.doc !== state.doc) {
    if (opts.explicit) showHint(view, "The file changed while formatting; try again");
    return NOTHING;
  }
  const changes = guardFormatChanges(state.doc.toString(), textEditsToChanges(state.doc, edits), guard);
  if (!changes.length) {
    if (opts.explicit) showHint(view, "No lines changed: content is already properly formatted");
    return NOTHING;
  }
  view.dispatch({
    changes,
    userEvent: "format",
    annotations: isolateHistory.of("full"),
    scrollIntoView: false,
  });
  return { applied: true, changes: changes.length, lines: formattedLines(state.doc, changes) };
}

function applyContributedFormat(
  view: EditorView,
  format: ContributedFormatter,
  opts: { explicit: boolean; selectionOnly?: boolean },
  guard: FormatGuardOptions,
): FormatResult {
  const state = view.state;
  if (state.readOnly) return NOTHING;
  const sel = state.selection.main;
  const useSelection = (opts.selectionOnly ?? true) && !sel.empty;
  const changes = guardFormatChanges(
    state.doc.toString(),
    format(state, useSelection ? { from: sel.from, to: sel.to } : null)
      .filter((c) => state.sliceDoc(c.from, c.to) !== c.insert)
      .sort((a, b) => a.from - b.from),
    guard,
  );
  if (!changes.length) {
    if (opts.explicit) showHint(view, "No lines changed: content is already properly formatted");
    return NOTHING;
  }
  view.dispatch({ changes, userEvent: "format", annotations: isolateHistory.of("full"), scrollIntoView: false });
  return { applied: true, changes: changes.length, lines: formattedLines(state.doc, changes) };
}

/** The dialog's last choices, as IDEA remembers them. */
let lastOptions: ReformatOptions = { selectionOnly: true, optimizeImports: false };

/**
 * Reformat File… (⌥⇧⌘L): asks for the scope and options, then optimizes
 * imports (when chosen) and reformats.
 */
export async function reformatDialog(
  view: EditorView,
  optimizeImports: (view: EditorView) => Promise<unknown> = async () => {},
): Promise<void> {
  const ctx = docOf(view);
  if (!ctx || ctx.readOnly) {
    if (ctx?.readOnly) showHint(view, "The file is read-only");
    return;
  }
  const sel = view.state.selection.main;
  const name = ctx.path.slice(ctx.path.lastIndexOf("/") + 1);
  openPopup({
    kind: "reformat",
    title: tx`Reformat File: ${name}`,
    hasSelection: !sel.empty,
    canOptimizeImports: !contributedAt(view.state, CONTRIBUTED_FORMAT, 0),
    initial: lastOptions,
    onRun: (options) =>
      void (async () => {
        lastOptions = { ...lastOptions, ...options, selectionOnly: sel.empty ? lastOptions.selectionOnly : options.selectionOnly };
        view.focus();
        if (options.optimizeImports) await optimizeImports(view);
        await formatDocument(view, { explicit: true, selectionOnly: options.selectionOnly });
      })(),
  });
}
