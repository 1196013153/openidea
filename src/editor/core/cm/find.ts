/**
 * Find / Replace in file. Matching and replacement (incl. regex groups) use
 * @codemirror/search's query + commands; the bar itself is a React component
 * (view/FindBar.tsx). Highlighting is ours because CodeMirror only highlights
 * while its own panel is open. Match positions found by the bar's counter are
 * kept in `findMarks` for the overview lane.
 */
import { EditorSelection, Prec, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  getSearchQuery,
  replaceAll as cmReplaceAll,
  replaceNext as cmReplaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { scrollbarMarks, type ScrollbarMark } from "@/editor/api";

export const setFindOpen = StateEffect.define<boolean>();
export const setFindMarks = StateEffect.define<number[]>();

/** "In Selection": the range Find / Replace is limited to (IDEA's selection scope). */
export interface FindScope {
  from: number;
  to: number;
}
export const setFindScope = StateEffect.define<FindScope | null>();

/** Maps a scope through edits; replacing text at either edge keeps it inside, typing next to it doesn't grow it. */
export function mapScope(scope: FindScope, changes: ChangeDesc): FindScope | null {
  const from = changes.mapPos(scope.from, 1);
  const to = Math.max(from, changes.mapPos(scope.to, -1));
  return to > from ? { from, to } : null;
}

const scopeDeco = Decoration.mark({ class: "cm-openidea-findScope" });

export const findScope = StateField.define<FindScope | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setFindScope)) return e.value;
      if (e.is(setFindOpen) && !e.value) return null;
    }
    return v && tr.docChanged ? mapScope(v, tr.changes) : v;
  },
  // Lowest precedence: the scope's mark wraps the match marks, which stay visible inside it.
  provide: (f) => Prec.lowest(EditorView.decorations.from(f, (s) => (s ? Decoration.set([scopeDeco.range(s.from, s.to)]) : Decoration.none))),
});

function scopeOf(state: EditorState): FindScope {
  return state.field(findScope, false) ?? { from: 0, to: state.doc.length };
}

export const findOpen = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFindOpen)) return e.value;
    return v;
  },
});

/** Start offsets of (up to MAX_COUNT) matches, for the overview lane. */
export const findMarks = StateField.define<number[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setFindMarks)) return e.value;
      if (e.is(setFindOpen) && !e.value) return [];
    }
    if (tr.docChanged && v.length) return v.map((p) => tr.changes.mapPos(p));
    return v;
  },
  provide: (f) =>
    scrollbarMarks.compute([f], (s): readonly ScrollbarMark[] =>
      s.field(f).map((from) => ({ from, color: "var(--warning)", kind: "thin" as const })),
    ),
});

const matchDeco = Decoration.mark({ class: "cm-openidea-findMatch" });
const currentDeco = Decoration.mark({ class: "cm-openidea-findMatch cm-openidea-findMatch-current" });
const MAX_VISIBLE = 2000;

function buildHighlights(view: EditorView): DecorationSet {
  const state = view.state;
  if (!state.field(findOpen, false)) return Decoration.none;
  const query = getSearchQuery(state);
  if (!query.valid) return Decoration.none;
  const main = state.selection.main;
  const scope = scopeOf(state);
  const ranges = [];
  let n = 0;
  for (const { from, to } of view.visibleRanges) {
    const a = Math.max(scope.from, from - 500);
    const b = Math.min(scope.to, to + 500);
    if (a >= b) continue;
    const cursor = query.getCursor(state, a, b);
    for (let r = cursor.next(); !r.done && n < MAX_VISIBLE; r = cursor.next(), n++) {
      const m = r.value;
      if (m.to === m.from) continue;
      ranges.push((m.from === main.from && m.to === main.to ? currentDeco : matchDeco).range(m.from, m.to));
    }
  }
  return Decoration.set(ranges, true);
}

const findHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHighlights(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        u.startState.field(findOpen, false) !== u.state.field(findOpen, false) ||
        getSearchQuery(u.startState) !== getSearchQuery(u.state) ||
        u.startState.field(findScope, false) !== u.state.field(findScope, false)
      )
        this.decorations = buildHighlights(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export function findExtension(): Extension {
  return [
    search({
      top: true,
      scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "center" }),
    }),
    findOpen,
    findScope,
    findMarks,
    findHighlighter,
  ];
}

export interface FindOptions {
  search: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  replace: string;
}

export function makeQuery(o: FindOptions) {
  return new SearchQuery({
    search: o.search,
    // Plain-text search and replace are literal (`\n` is not a newline), as in IDEA.
    literal: !o.regexp,
    caseSensitive: o.caseSensitive,
    wholeWord: o.wholeWord,
    regexp: o.regexp,
    replace: o.replace,
  });
}

export function setQuery(view: EditorView, o: FindOptions) {
  const q = makeQuery(o);
  if (q.eq(getSearchQuery(view.state))) return;
  view.dispatch({ effects: setSearchQuery.of(q) });
}

export function regexValid(source: string): boolean {
  try {
    new RegExp(source, "u");
    return true;
  } catch {
    return false;
  }
}

export const MAX_COUNT = 9_999;

/** Counts matches (capped) and the 1-based index of the selected one. */
export function countMatches(state: EditorState, budgetMs = 30): { total: number; current: number; capped: boolean; starts: number[] } {
  const query = getSearchQuery(state);
  if (!query.valid) return { total: 0, current: 0, capped: false, starts: [] };
  const main = state.selection.main;
  const t0 = performance.now();
  const starts: number[] = [];
  let current = 0;
  const scope = scopeOf(state);
  const cursor = query.getCursor(state, scope.from, scope.to);
  let capped = false;
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    const m = r.value;
    starts.push(m.from);
    if (m.from === main.from && m.to === main.to) current = starts.length;
    if (starts.length >= MAX_COUNT || (starts.length % 256 === 0 && performance.now() - t0 > budgetMs)) {
      capped = true;
      break;
    }
  }
  return { total: starts.length, current, capped, starts };
}

// --- commands (limited to the scope when there is one) ---------------------------

interface Match {
  from: number;
  to: number;
  match?: RegExpExecArray;
}

function matchesIn(state: EditorState, limit = Infinity): Match[] {
  const query = getSearchQuery(state);
  if (!query.valid) return [];
  const scope = scopeOf(state);
  const out: Match[] = [];
  const cursor = query.getCursor(state, scope.from, scope.to);
  for (let r = cursor.next(); !r.done && out.length < limit; r = cursor.next()) if (r.value.to > r.value.from) out.push(r.value as Match);
  return out;
}

/** The replacement text for a match (regex groups, `\n` in regex mode), as CodeMirror computes it. */
export function replacementFor(query: SearchQuery, m: Match): string {
  const impl = (query as unknown as { create?: () => { getReplacement(m: Match): string } }).create?.();
  if (impl) return impl.getReplacement(m);
  return query.replace;
}

function selectMatch(view: EditorView, m: Match) {
  view.dispatch({
    selection: EditorSelection.single(m.from, m.to),
    effects: EditorView.scrollIntoView(EditorSelection.range(m.from, m.to), { y: "center" }),
    userEvent: "select.search",
  });
}

function step(view: EditorView, forward: boolean): boolean {
  const ms = matchesIn(view.state);
  if (!ms.length) return false;
  const { from, to } = view.state.selection.main;
  const m = forward ? (ms.find((x) => x.from >= to && !(x.from === from && x.to === to)) ?? ms[0]!) : ([...ms].reverse().find((x) => x.to <= from) ?? ms[ms.length - 1]!);
  selectMatch(view, m);
  return true;
}

export function findNext(view: EditorView): boolean {
  return view.state.field(findScope, false) ? step(view, true) : cmFindNext(view);
}

export function findPrevious(view: EditorView): boolean {
  return view.state.field(findScope, false) ? step(view, false) : cmFindPrevious(view);
}

/** Replaces the selected match (if it is one) and selects the next match. */
export function replaceNext(view: EditorView): boolean {
  const { state } = view;
  if (!state.field(findScope, false)) return cmReplaceNext(view);
  if (state.readOnly) return false;
  const query = getSearchQuery(state);
  const ms = matchesIn(state);
  const { from, to } = state.selection.main;
  const cur = ms.find((m) => m.from === from && m.to === to);
  if (!cur) return step(view, true);
  const insert = replacementFor(query, cur);
  view.dispatch({ changes: { from: cur.from, to: cur.to, insert }, selection: EditorSelection.cursor(cur.from + insert.length), userEvent: "input.replace" });
  const next = matchesIn(view.state).find((m) => m.from >= cur.from + insert.length);
  if (next) selectMatch(view, next);
  return true;
}

export function replaceAll(view: EditorView): boolean {
  const { state } = view;
  if (!state.field(findScope, false)) return cmReplaceAll(view);
  if (state.readOnly) return false;
  const query = getSearchQuery(state);
  const changes = matchesIn(state).map((m) => ({ from: m.from, to: m.to, insert: replacementFor(query, m) }));
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input.replace.all" });
  return true;
}
