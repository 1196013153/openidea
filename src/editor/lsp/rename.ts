/**
 * Rename (⇧F6): `lsp_prepare_rename` → inline name popup at the symbol →
 * `lsp_rename` → preview dialog when the edit spans several files (or moves
 * files), otherwise applied directly via `apply_workspace_edit`.
 *
 * Dumb mode: when the server is not ready / failing, or answers nothing over
 * code with syntax errors, a *local* variable is renamed in place from the
 * syntax tree (definition + same-scope references, `{ x }` shorthands keep
 * their key). Anything else — members, types, top-level or cross-file
 * symbols — is left to the server. Ambiguous cases ask first.
 */
import type { EditorView } from "@codemirror/view";
import { commands, isCancelled, type Pos, type WorkspaceEdit } from "@/platform/ipc";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { structure } from "@/editor/structure";
import { docOf, lspRequest, reportLspError } from "./lsp";
import { comparePos, offsetToPos, rangeToOffsets } from "./positions";
import { showHint } from "./hint";
import { caretAnchor, openPopup, type PreviewOccurrence } from "./popupStore";
import { needsPreview, summarizeWorkspaceEdit } from "./workspaceEdit";
import {
  SYNTAX_NOTE,
  VALID_NAME,
  planLocalRename,
  renameChanges,
  renameRisks,
  type LocalRenamePlan,
} from "./syntaxFallback";

async function applyEdit(view: EditorView, edit: WorkspaceEdit) {
  try {
    await lspRequest(() => commands.applyWorkspaceEdit(edit));
  } catch (e) {
    reportLspError(view, e, true);
  }
}

async function hasSyntaxErrors(doc: number): Promise<boolean> {
  try {
    return (await structure.syntaxErrors(doc)).errors.length > 0;
  } catch {
    return false;
  }
}

export async function startRename(view: EditorView) {
  const doc = docOf(view);
  if (!doc) return;
  if (doc.readOnly) {
    showHint(view, "The file is read-only");
    return;
  }
  await whenSynced(view);
  const head = view.state.selection.main.head;
  const pos = offsetToPos(view.state.doc, head);
  let range;
  try {
    range = await lspRequest(() => commands.lspPrepareRename(doc.doc, pos));
  } catch (e) {
    if (isCancelled(e)) return;
    if (!(await startSyntaxRename(view, doc, pos))) reportLspError(view, e, true);
    return;
  }
  if (!range) {
    // A normal "can't rename" is respected; over broken code the server may just have given up.
    if ((await hasSyntaxErrors(doc.doc)) && (await startSyntaxRename(view, doc, pos))) return;
    showHint(view, "This element can't be renamed");
    return;
  }
  const { from, to } = rangeToOffsets(view.state.doc, range);
  const oldName = view.state.sliceDoc(from, to);
  openPopup({
    kind: "rename",
    anchor: caretAnchor(view, from),
    title: `Rename '${oldName}'`,
    initial: oldName,
    onSubmit: (newName) => void finishRename(view, doc, pos, oldName, newName),
  });
}

async function finishRename(view: EditorView, doc: EditorDocContext, pos: Pos, oldName: string, newName: string) {
  if (!newName || newName === oldName) return;
  let edit: WorkspaceEdit;
  try {
    edit = await lspRequest(() => commands.lspRename(doc.doc, pos, newName));
  } catch (e) {
    reportLspError(view, e, true);
    return;
  }
  const summary = summarizeWorkspaceEdit(edit);
  if (!summary.files) {
    if (await hasSyntaxErrors(doc.doc)) {
      const plan = await syntaxPlan(view, doc, pos);
      if (plan && plan.symbol.name === oldName) {
        await commitSyntaxRename(view, doc, plan, newName);
        return;
      }
    }
    showHint(view, "Nothing to rename");
    return;
  }
  if (!needsPreview(summary)) {
    await applyEdit(view, edit);
    return;
  }
  openPopup({
    kind: "preview",
    title: `Rename '${oldName}' to '${newName}'`,
    summary,
    confirmLabel: "Do Refactor",
    onConfirm: () => void applyEdit(view, edit),
  });
}

// ---------------------------------------------------------------------------
// Syntax-based local rename

/** The local rename plan at `pos`, or null when the element is not a local the fallback may rename. */
async function syntaxPlan(view: EditorView, doc: EditorDocContext, pos: Pos): Promise<LocalRenamePlan | null> {
  try {
    await whenSynced(view);
    const result = await planLocalRename(doc, pos);
    return result.kind === "plan" ? result.plan : null;
  } catch (e) {
    if (!isCancelled(e)) console.debug("[syntax] rename fallback", e);
    return null;
  }
}

/** Opens the rename popup for a syntax-based local rename. False when the fallback can't help. */
async function startSyntaxRename(view: EditorView, doc: EditorDocContext, pos: Pos): Promise<boolean> {
  let result;
  try {
    await whenSynced(view);
    result = await planLocalRename(doc, pos);
  } catch (e) {
    if (!isCancelled(e)) console.debug("[syntax] rename fallback", e);
    return false;
  }
  if (result.kind === "unsupported") return false;
  if (result.kind === "refused") {
    showHint(view, result.message);
    return true;
  }
  const { plan } = result;
  const at = plan.occurrences.find((o) => comparePos(o.range.start, pos) <= 0 && comparePos(pos, o.range.end) <= 0);
  openPopup({
    kind: "rename",
    anchor: caretAnchor(view, rangeToOffsets(view.state.doc, (at ?? plan.occurrences[0]!).range).from),
    title: `Rename '${plan.symbol.name}'`,
    initial: plan.symbol.name,
    note: `${SYNTAX_NOTE}: local occurrences only`,
    onSubmit: (newName) => void commitSyntaxRename(view, doc, plan, newName),
  });
  return true;
}

/** Applies a local rename in place, asking first when the syntax answer is not certain. */
export async function commitSyntaxRename(view: EditorView, doc: EditorDocContext, plan: LocalRenamePlan, newName: string) {
  const oldName = plan.symbol.name;
  if (!newName || newName === oldName) return;
  if (VALID_NAME.test(oldName) && !VALID_NAME.test(newName)) {
    showHint(view, `'${newName}' is not a valid identifier`, { tone: "error" });
    return;
  }
  const state = view.state;
  let risks: string[];
  try {
    risks = await renameRisks(doc.doc, plan, newName);
  } catch (e) {
    if (isCancelled(e)) return;
    risks = ["The name could not be checked for clashes."];
  }
  const apply = () => {
    if (view.state.doc !== state.doc) {
      showHint(view, "The file changed; rename cancelled", { tone: "warning" });
      return;
    }
    const changes = renameChanges(view.state.doc, plan, newName);
    if (!changes) {
      showHint(view, "The file changed; rename cancelled", { tone: "warning" });
      return;
    }
    view.dispatch({ changes, userEvent: "rename", scrollIntoView: true });
    showHint(view, `${SYNTAX_NOTE}: renamed ${changes.length} ${changes.length === 1 ? "occurrence" : "occurrences"}`, {
      timeout: 2500,
    });
  };
  if (!risks.length) {
    apply();
    return;
  }
  const occurrences: PreviewOccurrence[] = plan.occurrences.map((o) => {
    const { from, to } = rangeToOffsets(state.doc, o.range);
    const line = state.doc.lineAt(from);
    return { line: line.number - 1, text: line.text, from: from - line.from, to: Math.min(to, line.to) - line.from };
  });
  openPopup({
    kind: "preview",
    title: `Rename '${oldName}' to '${newName}'`,
    summary: {
      files: 1,
      occurrences: occurrences.length,
      hasFileOperations: false,
      entries: [{ path: doc.path, edits: occurrences.length }],
    },
    warnings: [...risks, `${SYNTAX_NOTE}. Only the occurrences below will be renamed.`],
    occurrences,
    confirmLabel: "Rename Anyway",
    onConfirm: apply,
  });
}
