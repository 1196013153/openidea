/**
 * Folding: ranges from the backend (`doc_folding`, tree-sitter based) merged
 * with CodeMirror's syntax folding (`foldNodeProp`) as fallback, IDEA-style
 * chevrons in the gutter (open chevrons only on gutter hover).
 */
import { Prec, StateEffect, StateField, type EditorState, type Extension, type Line } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, foldGutter, foldService, foldable, foldedRanges, unfoldEffect } from "@codemirror/language";
import type { FoldRange } from "@/platform/ipc";

export interface BackendFold {
  /** Offset where the fold starts (end of the header line). */
  from: number;
  to: number;
  /** 0-based header line at the time the folds were computed (for sticky scroll). */
  kind: FoldRange["kind"];
}

export const setBackendFolds = StateEffect.define<FoldRange[]>();

/**
 * A block whose `{` sits alone on its line (Allman style: C#, some Java / C)
 * folds from the declaration line above it, so the fold and the sticky line
 * show `namespace Demo` / `void F()` rather than a bare brace.
 */
function allmanHeader(state: EditorState, line: Line): Line {
  if (line.text.trim() !== "{" || line.number === 1) return line;
  const prev = state.doc.line(line.number - 1);
  const code = prev.text.trim();
  return code && !/[;{},]$/.test(code) && !/^(\/\/|#|\*|\/\*|--)/.test(code) ? prev : line;
}

/** Converts backend line ranges to offsets in `state`. */
export function foldsFromRanges(state: EditorState, ranges: readonly FoldRange[]): BackendFold[] {
  const out: BackendFold[] = [];
  const lines = state.doc.lines;
  for (const r of ranges) {
    if (r.start_line + 1 > lines || r.end_line + 1 > lines || r.end_line <= r.start_line) continue;
    const start = allmanHeader(state, state.doc.line(r.start_line + 1));
    const end = state.doc.line(r.end_line + 1);
    const trimmed = end.text.trimStart();
    // `}` / `)` / `]` on the last line stays visible after the placeholder, like IDEA.
    const to = /^[}\])]/.test(trimmed) ? end.from + (end.text.length - trimmed.length) : end.to;
    if (to > start.to) out.push({ from: start.to, to, kind: r.kind });
  }
  return out.sort((a, b) => a.from - b.from || b.to - a.to);
}

export const backendFolds = StateField.define<BackendFold[]>({
  create: () => [],
  update(folds, tr) {
    for (const e of tr.effects) if (e.is(setBackendFolds)) return foldsFromRanges(tr.state, e.value);
    if (!tr.docChanged || !folds.length) return folds;
    const out: BackendFold[] = [];
    for (const f of folds) {
      const from = tr.changes.mapPos(f.from, -1);
      const to = tr.changes.mapPos(f.to, 1);
      if (to > from) out.push({ ...f, from, to });
    }
    return out;
  },
});

/** First backend fold starting within [lineStart, lineEnd]. */
function foldAtLine(folds: readonly BackendFold[], lineStart: number, lineEnd: number): BackendFold | null {
  let lo = 0;
  let hi = folds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (folds[mid]!.from < lineStart) lo = mid + 1;
    else hi = mid;
  }
  let best: BackendFold | null = null;
  for (let i = lo; i < folds.length && folds[i]!.from <= lineEnd; i++) {
    const f = folds[i]!;
    // Only folds whose header ends on this line; keep the widest.
    if (f.from === lineEnd && (!best || f.to > best.to)) best = f;
  }
  return best;
}

const backendFoldService = foldService.of((state, lineStart, lineEnd) => {
  const folds = state.field(backendFolds, false);
  if (!folds?.length) return null;
  const f = foldAtLine(folds, lineStart, lineEnd);
  if (!f) return null;
  // Don't fold away the caret line's own content.
  return { from: f.from, to: f.to };
});

/** Lines scanned upwards from the caret when looking for the enclosing fold region. */
const MAX_SCAN_LINES = 2000;

/**
 * IDEA "Collapse" (⌘-): the innermost not-yet-folded region that contains the
 * caret — the caret line's own region first, then enclosing ones above it.
 */
export function enclosingFoldRange(state: EditorState, pos: number): { from: number; to: number } | null {
  const folded = foldedRanges(state);
  const isFolded = (r: { from: number; to: number }) => {
    let hit = false;
    folded.between(r.from, r.from, (a, b) => {
      if (a === r.from && b === r.to) hit = true;
    });
    return hit;
  };
  let line = state.doc.lineAt(pos);
  for (let i = 0; i < MAX_SCAN_LINES; i++) {
    const r = foldable(state, line.from, line.to);
    const onCaretLine = i === 0;
    if (r && (onCaretLine || (r.from <= pos && pos <= r.to)) && !isFolded(r)) return r;
    if (line.number === 1) break;
    line = state.doc.line(line.number - 1);
  }
  return null;
}

/** Folds the region around each caret. */
export function foldAtCaret(view: EditorView): boolean {
  const effects: StateEffect<unknown>[] = [];
  for (const range of view.state.selection.ranges) {
    const r = enclosingFoldRange(view.state, range.head);
    if (r) effects.push(foldEffect.of(r));
  }
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

/**
 * IDEA "Expand" (⌘=): the visible fold at the caret — the outermost fold
 * containing it (inner ones are hidden inside it), else a fold on its line.
 */
export function foldToExpand(state: EditorState, head: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(head);
  let containing: { from: number; to: number } | null = null;
  let onLine: { from: number; to: number } | null = null;
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    if (from <= head && head <= to) {
      if (!containing || to - from > containing.to - containing.from) containing = { from, to };
    } else if (from >= line.from && from <= line.to) {
      if (!onLine || to - from > onLine.to - onLine.from) onLine = { from, to };
    }
  });
  return containing ?? onLine;
}

export function unfoldAtCaret(view: EditorView): boolean {
  const effects: StateEffect<unknown>[] = [];
  for (const range of view.state.selection.ranges) {
    const r = foldToExpand(view.state, range.head);
    if (r) effects.push(unfoldEffect.of(r));
  }
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

/**
 * IDEA "Fold Selection / Remove Region" (⌘.): folds each selection; with no
 * selection, expands the fold at the caret.
 */
export function foldSelectionEffects(state: EditorState): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = [];
  for (const range of state.selection.ranges) {
    if (!range.empty) {
      effects.push(foldEffect.of({ from: range.from, to: range.to }));
      continue;
    }
    const r = foldToExpand(state, range.head);
    if (r) effects.push(unfoldEffect.of(r));
  }
  return effects;
}

export function foldSelection(view: EditorView): boolean {
  const effects = foldSelectionEffects(view.state);
  if (!effects.length) return false;
  const sel = view.state.selection;
  // The caret lands after the fold, like IDEA.
  view.dispatch({ effects, selection: sel.ranges.some((r) => !r.empty) ? { anchor: sel.main.to } : undefined });
  return true;
}

function chevron(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = open ? "cm-openidea-foldOpen" : "cm-openidea-foldClosed";
  span.title = open ? "Collapse" : "Expand";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "9");
  svg.setAttribute("height", "9");
  svg.setAttribute("viewBox", "0 0 9 9");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", open ? "M8 2.75 4.5 6.25 1 2.75" : "M3 8 6.5 4.5 3 1");
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

export function foldingExtension(showOutline = true): Extension {
  return [
    // The chevron column sits right of contributed icon gutters (IDEA new UI).
    showOutline ? Prec.lowest(foldGutter({ markerDOM: chevron })) : [],
    backendFolds,
    backendFoldService,
    codeFolding({
      placeholderDOM: (_view, onclick) => {
        const el = document.createElement("span");
        el.className = "cm-foldPlaceholder";
        el.textContent = "…";
        el.title = "Expand";
        el.setAttribute("aria-label", "folded code");
        el.onclick = onclick;
        return el;
      },
    }),
  ];
}
