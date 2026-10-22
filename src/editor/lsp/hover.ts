/**
 * Hover tooltip (500ms): diagnostics under the pointer + quick documentation,
 * plus the explicit actions code.quickDocumentation (F1, sticky popup) and
 * code.quickDefinition (⌥Space, definition source popup).
 */
import { EditorSelection } from "@codemirror/state";
import { hoverTooltip, type EditorView } from "@codemirror/view";
import { commands, isTauri, nextRequestId, type Hover, type RequestId } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { diagnosticsAt, type PlacedDiagnostic } from "./diagnostics";
import { isEmptyMarkup, languageForPath, renderMarkup } from "./markdown";
import { docOf, lspRequest, reportLspError } from "./lsp";
import { offsetToPos, rangeToOffsets } from "./positions";
import { showHint } from "./hint";
import { caretAnchor, openPopup } from "./popupStore";
import { readFileLines } from "./files";
import { iconNode } from "./iconMarkup";
import { editorPrefs } from "@/platform/editorSettings";
import { CONTRIBUTED_HOVER, contributedAt, type ContributedHover } from "@/editor/api";

let hoverRequest: RequestId | null = null;

export async function requestHover(view: EditorView, pos: number): Promise<Hover | null> {
  const own = contributedAt<ContributedHover>(view.state, CONTRIBUTED_HOVER, pos);
  if (own) {
    const h = own(view.state, pos);
    if (!h) return null;
    const range = { start: offsetToPos(view.state.doc, h.from), end: offsetToPos(view.state.doc, h.to) };
    return { contents: { kind: "markdown", value: h.markdown }, range };
  }
  const doc = docOf(view);
  if (!doc) return null;
  if (hoverRequest !== null && isTauri()) void commands.cancelRequest(hoverRequest);
  const id = (hoverRequest = nextRequestId());
  try {
    const h = await lspRequest(() => commands.lspHover(id, doc.doc, offsetToPos(view.state.doc, pos)));
    return h && !isEmptyMarkup(h.contents) ? h : null;
  } finally {
    if (hoverRequest === id) hoverRequest = null;
  }
}

function renderDiagnostics(view: EditorView, diags: PlacedDiagnostic[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-lsp-hover-diagnostics";
  for (const { diagnostic: d, from } of diags) {
    const row = document.createElement("div");
    row.className = `cm-lsp-diag cm-lsp-diag-${d.severity}`;
    row.appendChild(iconNode(d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info", 16, "cm-lsp-diag-icon"));
    const msg = document.createElement("div");
    msg.className = "cm-lsp-diag-message";
    msg.textContent = d.message;
    row.appendChild(msg);
    const meta = document.createElement("div");
    meta.className = "cm-lsp-diag-meta";
    if (d.source) {
      const src = document.createElement("span");
      src.className = "cm-lsp-diag-source";
      src.textContent = d.source;
      meta.appendChild(src);
    }
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "cm-lsp-link-button";
    const keys = shortcutLabel("code.showIntentions");
    fix.textContent = keys ? `More actions… ${keys}` : "More actions…";
    fix.addEventListener("mousedown", (e) => e.preventDefault());
    fix.addEventListener("click", () => {
      view.dispatch({ selection: EditorSelection.cursor(from) });
      view.focus();
      void executeAction("code.showIntentions");
    });
    meta.appendChild(fix);
    row.appendChild(meta);
    box.appendChild(row);
  }
  return box;
}

/** Hover: problems always; quick documentation per Settings › Editor › Code Editing. */
export function hoverExtension() {
  return hoverTooltip(
    async (view, pos) => {
      const diags = diagnosticsAt(view, pos);
      let hover: Hover | null = null;
      if (editorPrefs().codeEditing.quickDocOnHover)
        try {
          hover = await requestHover(view, pos);
        } catch (e) {
          reportLspError(view, e, false);
        }
      if (!diags.length && !hover) return null;
      let from = pos,
        to = pos;
      if (hover?.range) ({ from, to } = rangeToOffsets(view.state.doc, hover.range));
      else if (diags.length) ({ from, to } = diags[0]!);
      else {
        const word = view.state.wordAt(pos);
        if (word) ({ from, to } = word);
      }
      const lang = docOf(view)?.uiMode ?? null;
      return {
        pos: from,
        end: to,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "cm-lsp-hover";
          if (diags.length) dom.appendChild(renderDiagnostics(view, diags));
          if (hover) dom.appendChild(renderMarkup(hover.contents, lang));
          return { dom };
        },
      };
    },
    { hoverTime: Math.max(100, editorPrefs().codeEditing.quickDocDelay) },
  );
}

/** F1: documentation for the symbol at the caret in a sticky popup. */
export async function quickDocumentation(view: EditorView) {
  const pos = view.state.selection.main.head;
  try {
    const hover = await requestHover(view, pos);
    if (!hover) {
      showHint(view, "No documentation found");
      return;
    }
    openPopup({
      kind: "doc",
      anchor: caretAnchor(view, hover.range ? rangeToOffsets(view.state.doc, hover.range).from : pos),
      markup: hover.contents,
      language: docOf(view)?.uiMode ?? null,
      themeClasses: view.themeClasses,
    });
  } catch (e) {
    reportLspError(view, e, true);
  }
}

const DEFINITION_CONTEXT_BEFORE = 1;
const DEFINITION_MAX_LINES = 30;

/** ⌥Space: the definition's source in a popup, without leaving the editor. */
export async function quickDefinition(view: EditorView) {
  const doc = docOf(view);
  if (!doc) return;
  const pos = view.state.selection.main.head;
  try {
    const locations = await lspRequest(() => commands.lspGoto(doc.doc, offsetToPos(view.state.doc, pos), "definition"));
    const loc = locations[0];
    if (!loc) {
      showHint(view, "No definition found");
      return;
    }
    const lines = await readFileLines(loc.path);
    if (!lines) {
      showHint(view, "Cannot read the definition's file");
      return;
    }
    const first = Math.max(0, loc.range.start.line - DEFINITION_CONTEXT_BEFORE);
    const spanEnd = Math.max(loc.range.end.line, loc.range.start.line + 12);
    const last = Math.min(lines.length - 1, Math.min(spanEnd, first + DEFINITION_MAX_LINES - 1));
    openPopup({
      kind: "definition",
      anchor: caretAnchor(view, pos),
      location: loc,
      firstLine: first,
      text: lines.slice(first, last + 1).join("\n"),
      language: languageForPath(loc.path) ?? doc.uiMode,
      themeClasses: view.themeClasses,
    });
  } catch (e) {
    reportLspError(view, e, true);
  }
}
