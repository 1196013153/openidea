/**
 * Diagnostics in the editor: the backend pushes full per-(file, producer)
 * replacements (`IdeEvent::diagnostics`); each editor shows the union for its
 * path through `@codemirror/lint` (wavy underlines, no gutter, no lint
 * tooltip — `hover.ts` renders diagnostics together with documentation).
 */
import type { Text } from "@codemirror/state";
import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { forEachDiagnostic, linter, setDiagnostics, type Diagnostic as LintDiagnostic } from "@codemirror/lint";
import type { Diagnostic, Severity } from "@/bindings";
import { onIdeEvent } from "@/platform/ipc";
import { scrollbarMarks, type ScrollbarMark } from "@/editor/api";
import { rangeToOffsets } from "./positions";
import { lspDoc } from "./lsp";
import { showHint } from "./hint";
import { editorPrefs } from "@/platform/editorSettings";

type Listener = () => void;

const byPath = new Map<string, Map<string, Diagnostic[]>>();
const listeners = new Map<string, Set<Listener>>();

export function setFileDiagnostics(path: string, source: string, items: Diagnostic[]) {
  let sources = byPath.get(path);
  if (!items.length) {
    if (!sources?.delete(source)) return;
    if (!sources.size) byPath.delete(path);
  } else {
    if (!sources) byPath.set(path, (sources = new Map()));
    sources.set(source, items.map((d) => ({ ...d, source: d.source ?? source })));
  }
  listeners.get(path)?.forEach((l) => l());
}

export function diagnosticsFor(path: string): Diagnostic[] {
  const sources = byPath.get(path);
  return sources ? [...sources.values()].flat() : [];
}

export function subscribeDiagnostics(path: string, l: Listener): () => void {
  let set = listeners.get(path);
  if (!set) listeners.set(path, (set = new Set()));
  set.add(l);
  return () => {
    set.delete(l);
    if (!set.size) listeners.delete(path);
  };
}

export function installDiagnosticsEvents(): () => void {
  return onIdeEvent("diagnostics", (e) => setFileDiagnostics(e.path, e.source, e.items));
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** Backend diagnostics → lint diagnostics for `doc` (empty ranges widened to one character). */
export function toLintDiagnostics(doc: Text, items: readonly Diagnostic[]): LintDiagnostic[] {
  const out: LintDiagnostic[] = items.map((d) => {
    let { from, to } = rangeToOffsets(doc, d.range);
    if (from === to) {
      const line = doc.lineAt(from);
      if (to < line.to) to++;
      else if (from > line.from) from--;
    }
    const classes = [d.unnecessary && "cm-lsp-unnecessary", d.deprecated && "cm-lsp-deprecated"].filter(Boolean);
    return {
      from,
      to,
      severity: d.severity,
      message: d.message,
      source: [d.source, d.code].filter(Boolean).join(" ") || undefined,
      markClass: classes.length ? classes.join(" ") : undefined,
    };
  });
  return out.sort((a, b) => a.from - b.from || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

const MARK_COLOR: Partial<Record<Severity, string>> = {
  error: "var(--danger)",
  warning: "var(--warning)",
  info: "var(--info)",
};

/** Overview-lane (scrollbar) marks for diagnostics, errors on top. */
export function diagnosticMarks(diags: readonly LintDiagnostic[]): ScrollbarMark[] {
  const out: ScrollbarMark[] = [];
  for (const d of diags) {
    const color = MARK_COLOR[d.severity];
    if (!color || d.markClass?.includes("cm-lsp-unnecessary")) continue;
    out.push({ from: d.from, to: d.to, color, tooltip: d.message, priority: 3 - SEVERITY_RANK[d.severity] });
  }
  return out;
}

const setMarks = StateEffect.define<readonly ScrollbarMark[]>();

const marksField = StateField.define<readonly ScrollbarMark[]>({
  create: () => [],
  update(marks, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    if (!tr.docChanged || !marks.length) return marks;
    return marks.map((m) => {
      const from = tr.changes.mapPos(m.from);
      return { ...m, from, to: Math.max(from, tr.changes.mapPos(m.to ?? m.from)) };
    });
  },
  provide: (f) => scrollbarMarks.from(f),
});

const diagnosticsSync = ViewPlugin.fromClass(
  class {
    private unsubscribe: () => void;
    private pending = false;
    constructor(private view: EditorView) {
      const path = view.state.facet(lspDoc)?.path;
      this.unsubscribe = path ? subscribeDiagnostics(path, () => this.schedule()) : () => {};
      if (path && diagnosticsFor(path).length) this.schedule();
    }
    schedule() {
      if (this.pending) return;
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        const path = this.view.state.facet(lspDoc)?.path;
        if (!path || !this.view.dom.isConnected) return;
        const lint = toLintDiagnostics(this.view.state.doc, diagnosticsFor(path));
        const tr = setDiagnostics(this.view.state, lint);
        this.view.dispatch({ ...tr, effects: [...[tr.effects ?? []].flat(), setMarks.of(diagnosticMarks(lint))] });
      });
    }
    destroy() {
      this.unsubscribe();
    }
  },
);

// Effects follow the IDEA schemes: errors wavy red; warnings wavy yellow (dark) or
// a yellow background (light, via --editor-warning-*); weak warnings dotted.
const lintTheme = EditorView.theme({
  ".cm-lintRange": { backgroundImage: "none", paddingBottom: "0" },
  ".cm-lintRange-error": {
    textDecoration: "var(--editor-error-decoration, underline wavy var(--danger))",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-warning": {
    textDecoration: "var(--editor-warning-decoration, underline wavy var(--warning))",
    backgroundColor: "var(--editor-warning-background, transparent)",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-info": {
    textDecoration: "underline dotted color-mix(in srgb, var(--fg-muted) 80%, transparent)",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-hint": { textDecoration: "none" },
  ".cm-lintRange.cm-lsp-unnecessary": {
    textDecoration: "none",
    backgroundColor: "transparent",
    color: "var(--fg-unused, var(--fg-faint))",
  },
  ".cm-lintRange.cm-lsp-unnecessary *": { color: "var(--fg-unused, var(--fg-faint))" },
  ".cm-lintRange.cm-lsp-deprecated": { textDecoration: "line-through", textDecorationColor: "var(--fg-muted)" },
  ".cm-lintRange-active": { backgroundColor: "transparent" },
  ".cm-lintRange-warning.cm-lintRange-active": { backgroundColor: "var(--editor-warning-background, transparent)" },
  ".cm-lintPoint:after": { display: "none" },
});

export function diagnosticsExtension() {
  return [
    linter(null, { tooltipFilter: () => [], autoPanel: false }),
    marksField,
    diagnosticsSync,
    lintTheme,
  ];
}

export interface PlacedDiagnostic {
  from: number;
  to: number;
  diagnostic: LintDiagnostic;
}

export function diagnosticsAt(view: EditorView, pos: number): PlacedDiagnostic[] {
  const out: PlacedDiagnostic[] = [];
  forEachDiagnostic(view.state, (d, from, to) => {
    if (from <= pos && pos <= to) out.push({ from, to, diagnostic: d });
  });
  return out.sort((a, b) => SEVERITY_RANK[a.diagnostic.severity] - SEVERITY_RANK[b.diagnostic.severity]);
}

/**
 * F2 / ⇧F2: the next highlighted problem after (before) the caret, wrapping.
 * Like IDEA, errors take priority: warnings are visited only when the file has
 * no errors. Hints are skipped unless nothing else exists.
 */
export function gotoDiagnostic(view: EditorView, dir: 1 | -1): boolean {
  const all: PlacedDiagnostic[] = [];
  forEachDiagnostic(view.state, (d, from, to) => all.push({ from, to, diagnostic: d }));
  if (!all.length) {
    showHint(view, "No problems in this file");
    return false;
  }
  const best = Math.min(...all.map((p) => Math.min(SEVERITY_RANK[p.diagnostic.severity], 2)));
  // "Next error action goes to high priority problems only" (Code Editing).
  const highOnly = editorPrefs().codeEditing.nextErrorErrorsOnly;
  const list = all
    .filter((p) => (highOnly ? Math.min(SEVERITY_RANK[p.diagnostic.severity], 2) === best : true))
    .sort((a, b) => a.from - b.from);
  const head = view.state.selection.main.head;
  const target =
    dir === 1
      ? (list.find((p) => p.from > head) ?? list[0]!)
      : ([...list].reverse().find((p) => p.from < head && !(p.from <= head && head <= p.to)) ?? list[list.length - 1]!);
  view.dispatch({ selection: EditorSelection.cursor(target.from), scrollIntoView: true, userEvent: "select" });
  showHint(view, target.diagnostic.message, {
    pos: target.from,
    tone: target.diagnostic.severity === "error" ? "error" : target.diagnostic.severity === "warning" ? "warning" : "info",
    timeout: 6000,
  });
  return true;
}
