/**
 * Code actions: the lightbulb on the caret line (debounced lookup), the ⌥↵
 * intentions popup (quick fixes first, preferred in bold), Optimize Imports and
 * Generate. Refactor This and the Refactor menu live in `@/editor/refactor`.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import { commands, isCancelled, type CodeAction } from "@/platform/ipc";
import { whenSynced } from "@/editor/api";
import { shortcutLabel } from "@/platform/keymap";
import { debounce, docOf, isUnavailable, lspRequest, reportLspError } from "./lsp";
import { offsetsToRange } from "./positions";
import { showHint } from "./hint";
import { caretAnchor, openPopup, type ListPopupItem } from "./popupStore";
import { serverBackoff } from "./availability";
import { iconNode } from "./iconMarkup";
import { editorPrefs } from "@/platform/editorSettings";

const isQuickFix = (a: CodeAction) => !!a.kind && (a.kind === "quickfix" || a.kind.startsWith("quickfix."));

/** IDEA ordering: quick fixes first, preferred before others, disabled last; stable otherwise. */
export function sortCodeActions(actions: readonly CodeAction[]): CodeAction[] {
  const rank = (a: CodeAction) => (a.disabledReason ? 4 : 0) + (isQuickFix(a) ? 0 : 2) + (a.isPreferred ? 0 : 1);
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map((x) => x.a);
}

async function fetchActions(view: EditorView, only: string[], whole = false): Promise<CodeAction[]> {
  const doc = docOf(view);
  if (!doc) return [];
  await whenSynced(view);
  const sel = view.state.selection.main;
  const range = whole ? offsetsToRange(view.state.doc, 0, view.state.doc.length) : offsetsToRange(view.state.doc, sel.from, sel.to);
  return lspRequest(() => commands.lspCodeActions(doc.doc, range, only));
}

export async function applyCodeAction(view: EditorView, action: CodeAction) {
  const doc = docOf(view);
  if (!doc) return;
  if (action.disabledReason) {
    showHint(view, action.disabledReason);
    return;
  }
  try {
    await lspRequest(() => commands.lspApplyCodeAction(doc.doc, action));
  } catch (e) {
    reportLspError(view, e, true);
  }
}

/**
 * Applies the first enabled whole-file action of `kind` without UI (Actions on
 * Save). Waits until the backend edit reached this editor; false when none.
 */
export async function applyKindSilently(view: EditorView, kind: string): Promise<boolean> {
  const doc = docOf(view);
  if (!doc || doc.readOnly) return false;
  let actions: CodeAction[];
  try {
    actions = (await fetchActions(view, [kind], true)).filter((a) => a.kind?.startsWith(kind) && !a.disabledReason);
  } catch {
    return false;
  }
  const action = actions.find((a) => a.isPreferred) ?? actions[0];
  if (!action) return false;
  const before = view.state.doc;
  try {
    await lspRequest(() => commands.lspApplyCodeAction(doc.doc, action));
  } catch {
    return false;
  }
  for (let i = 0; i < 25 && view.state.doc === before; i++) await new Promise((r) => setTimeout(r, 20));
  return true;
}

function actionItems(view: EditorView, actions: CodeAction[]): ListPopupItem[] {
  return sortCodeActions(actions).map((a, i) => ({
    id: `${i}`,
    label: a.title,
    icon: isQuickFix(a) ? "bulb-fix" : "bulb",
    emphasis: a.isPreferred,
    disabled: a.disabledReason,
    run: () => applyCodeAction(view, a),
  }));
}

/** ⌥↵ */
export async function showIntentions(view: EditorView) {
  try {
    // Like IDEA, only applicable intentions are listed (servers also report disabled refactorings).
    const actions = (await fetchActions(view, [])).filter((a) => !a.disabledReason);
    if (!actions.length) {
      showHint(view, "No intentions available");
      return;
    }
    openPopup({
      kind: "list",
      anchor: caretAnchor(view, view.state.selection.main.head),
      title: "Intentions",
      items: actionItems(view, actions),
    });
  } catch (e) {
    reportLspError(view, e, true);
  }
}

/** Runs the single matching action of `kind` (optionally filtered by title), or offers a choice. */
export async function runKindAction(
  view: EditorView,
  /** LSP `CodeActionKind` prefix; `""` for any kind. */
  kind: string,
  opts: {
    title?: RegExp;
    whole?: boolean;
    none: string;
    label: string;
    /**
     * Syntax-based fallback when the server offers no enabled action
     * (`empty`) or cannot answer; true when it handled the request.
     */
    fallback?: (reason: "notReady" | "error" | "empty") => Promise<boolean>;
  },
) {
  let actions: CodeAction[];
  try {
    // An empty kind asks for every action (filtered by title only).
    actions = await fetchActions(view, kind ? [kind] : [], opts.whole);
  } catch (e) {
    if (!isCancelled(e) && opts.fallback && (await opts.fallback(isUnavailable(e) ? "notReady" : "error"))) return;
    reportLspError(view, e, true);
    return;
  }
  try {
    if (kind) actions = actions.filter((a) => a.kind?.startsWith(kind) ?? false);
    if (opts.title) actions = actions.filter((a) => opts.title!.test(a.title));
    const enabled = actions.filter((a) => !a.disabledReason);
    if (!enabled.length) {
      if (opts.fallback && (await opts.fallback("empty"))) return;
      showHint(view, actions[0]?.disabledReason ?? noActionReason(view, opts.none));
      return;
    }
    if (enabled.length === 1) {
      await applyCodeAction(view, enabled[0]!);
      return;
    }
    openPopup({
      kind: "list",
      anchor: caretAnchor(view, view.state.selection.main.head),
      title: opts.label,
      items: actionItems(view, enabled),
    });
  } catch (e) {
    reportLspError(view, e, true);
  }
}

/** Servers offer no refactorings over broken code; say so instead of a bare "cannot". */
function noActionReason(view: EditorView, none: string): string {
  const sel = view.state.selection.main;
  const from = view.state.doc.lineAt(sel.from).from;
  const to = view.state.doc.lineAt(sel.to).to;
  let error: string | null = null;
  forEachDiagnostic(view.state, (d, a, b) => {
    if (!error && d.severity === "error" && a <= to && b >= from) error = d.message;
  });
  return error ? `${none}: fix the error first (${error})` : none;
}

// ---------------------------------------------------------------------------
// Lightbulb

interface Bulb {
  line: number;
  quickFix: boolean;
}

const setBulb = StateEffect.define<Bulb | null>();

const bulbField = StateField.define<Bulb | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBulb)) return e.value;
    if (value && (tr.docChanged || tr.selection)) {
      const line = tr.state.doc.lineAt(tr.state.selection.main.head).number;
      return line === value.line && !tr.docChanged ? value : null;
    }
    return value;
  },
});

const bulbPlugin = ViewPlugin.fromClass(
  class {
    private lookup = debounce(() => void this.run(), 500);
    constructor(private view: EditorView) {
      this.lookup();
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.lookup();
    }
    async run() {
      const doc = docOf(this.view);
      if (!doc || doc.readOnly || serverBackoff.active(doc.doc) || !this.view.dom.isConnected) return;
      const state = this.view.state;
      try {
        const actions = (await fetchActions(this.view, [])).filter((a) => !a.disabledReason);
        if (this.view.state.doc !== state.doc || !this.view.state.selection.eq(state.selection)) return;
        const line = state.doc.lineAt(state.selection.main.head).number;
        this.view.dispatch({
          effects: setBulb.of(actions.length ? { line, quickFix: actions.some(isQuickFix) } : null),
        });
      } catch (e) {
        if (isUnavailable(e)) serverBackoff.mark(doc.doc);
      }
    }
    destroy() {
      this.lookup.cancel();
    }
  },
);

/**
 * New-UI bulb: floats at the start of the text on the caret line, or on the
 * line below / above when the caret line's text starts at the left edge.
 */
const BULB_COLUMNS = 3;

function bulbLine(state: EditorView["state"], line: number): number {
  const doc = state.doc;
  const free = (n: number) => {
    if (n < 1 || n > doc.lines) return false;
    const text = doc.line(n).text;
    return text.length - text.trimStart().length >= BULB_COLUMNS || !text.trim();
  };
  if (free(line)) return line;
  if (free(line + 1)) return line + 1;
  if (free(line - 1)) return line - 1;
  return line;
}

class FloatingBulb {
  dom: HTMLElement;
  private shown: Bulb | null = null;

  constructor(private view: EditorView) {
    this.dom = document.createElement("span");
    this.dom.className = "cm-lsp-bulb";
    this.dom.setAttribute("role", "button");
    this.dom.setAttribute("aria-label", "Show intentions");
    this.dom.style.display = "none";
    this.dom.appendChild(iconNode("bulb", 16));
    this.dom.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void showIntentions(this.view);
    });
    view.scrollDOM.appendChild(this.dom);
    this.place();
  }

  update(u: ViewUpdate) {
    const bulb = u.state.field(bulbField, false) ?? null;
    if (bulb !== this.shown || u.geometryChanged || u.viewportChanged) this.place();
  }

  private place() {
    const bulb = this.view.state.field(bulbField, false) ?? null;
    this.shown = bulb;
    if (!bulb || bulb.line > this.view.state.doc.lines || !editorPrefs().appearance.intentionBulb) {
      this.dom.style.display = "none";
      return;
    }
    const keys = shortcutLabel("code.showIntentions");
    this.dom.title = `Show intentions${keys ? ` (${keys})` : ""}`;
    this.dom.classList.toggle("cm-lsp-bulb-fix", bulb.quickFix);
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const line = view.state.doc.line(bulbLine(view.state, bulb.line));
        const block = view.lineBlockAt(line.from);
        const content = view.contentDOM.getBoundingClientRect();
        const scroller = view.scrollDOM.getBoundingClientRect();
        return {
          top: block.top + (view.documentTop - scroller.top) + view.scrollDOM.scrollTop,
          left: content.left - scroller.left + view.scrollDOM.scrollLeft + 4,
          height: block.height,
        };
      },
      write: ({ top, left, height }) => {
        this.dom.style.display = "";
        this.dom.style.top = `${top}px`;
        this.dom.style.left = `${left}px`;
        this.dom.style.height = `${Math.min(height, this.view.defaultLineHeight)}px`;
      },
    });
  }

  destroy() {
    this.dom.remove();
  }
}

const floatingBulb = ViewPlugin.fromClass(FloatingBulb);

export function intentionsExtension(): Extension {
  return [bulbField, bulbPlugin, floatingBulb];
}
