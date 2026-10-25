/**
 * IDEA editing commands on top of @codemirror/commands.
 */
import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange, type Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import { syntaxTree, getIndentUnit, indentString, getIndentation } from "@codemirror/language";
import {
  copyLineDown,
  insertNewlineAndIndent,
  moveLineDown,
  moveLineUp,
} from "@codemirror/commands";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { humpLeft, humpRight } from "../model/camelHumps";

// --- CamelHumps -------------------------------------------------------------

function humpTarget(state: EditorState, pos: number, forward: boolean): number {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  if (forward) {
    if (col >= line.length) return Math.min(state.doc.length, line.to + 1);
    return line.from + humpRight(line.text, col);
  }
  if (col <= 0) return Math.max(0, line.from - 1);
  return line.from + humpLeft(line.text, col);
}

function moveHump(forward: boolean, extend: boolean): Command {
  return (view) => {
    const sel = EditorSelection.create(
      view.state.selection.ranges.map((r) => {
        if (!extend && !r.empty) return EditorSelection.cursor(forward ? r.to : r.from);
        const head = humpTarget(view.state, r.head, forward);
        return extend ? EditorSelection.range(r.anchor, head) : EditorSelection.cursor(head);
      }),
      view.state.selection.mainIndex,
    );
    view.dispatch({ selection: sel, scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

export const cursorHumpLeft = moveHump(false, false);
export const cursorHumpRight = moveHump(true, false);
export const selectHumpLeft = moveHump(false, true);
export const selectHumpRight = moveHump(true, true);

function deleteHump(forward: boolean): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const tr = view.state.changeByRange((r) => {
      if (!r.empty) return { changes: { from: r.from, to: r.to }, range: EditorSelection.cursor(r.from) };
      const target = humpTarget(view.state, r.head, forward);
      const from = Math.min(target, r.head);
      const to = Math.max(target, r.head);
      return { changes: { from, to }, range: EditorSelection.cursor(from) };
    });
    view.dispatch(view.state.update(tr, { scrollIntoView: true, userEvent: forward ? "delete.forward" : "delete.backward" }));
    return true;
  };
}

export const deleteHumpBackward = deleteHump(false);
export const deleteHumpForward = deleteHump(true);

// --- lines / selections -------------------------------------------------------

/** ⌘D: duplicate the line (caret moves to the copy) or the selection (copy selected). */
export const duplicateLineOrSelection: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  if (state.selection.ranges.every((r) => r.empty)) return copyLineDown(view);
  const tr = state.changeByRange((r) => {
    if (r.empty) {
      const line = state.doc.lineAt(r.head);
      return {
        changes: { from: line.to, insert: state.lineBreak + line.text },
        range: EditorSelection.cursor(r.head + line.length + 1),
      };
    }
    const text = state.sliceDoc(r.from, r.to);
    return {
      changes: { from: r.to, insert: text },
      range: EditorSelection.range(r.to, r.to + text.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.duplicate" }));
  return true;
};

/** ⌃G: add the next occurrence of the word / selection as a caret. */
export const addCaretNextOccurrence: Command = (view) => selectNextOccurrence(view);

/** ⌃⌘G: select every occurrence of the word / selection. */
export const selectAllOccurrences: Command = (view) => {
  const { state } = view;
  if (state.selection.main.empty) {
    const word = state.wordAt(state.selection.main.head);
    if (!word) return false;
    view.dispatch({ selection: EditorSelection.single(word.from, word.to) });
  }
  return selectSelectionMatches(view);
};

// --- move statement -----------------------------------------------------------

interface LineSpan {
  from: number; // line start
  to: number; // line end (excl. break)
}

function wholeLines(state: EditorState, from: number, to: number): LineSpan {
  return { from: state.doc.lineAt(from).from, to: state.doc.lineAt(to).to };
}

/** The statement-like syntax node starting on the caret's line, as whole lines. */
function statementAt(state: EditorState, pos: number): { span: LineSpan; node: { from: number; to: number; parent: unknown } } | null {
  const line = state.doc.lineAt(pos);
  const indent = /^\s*/.exec(line.text)![0].length;
  const start = line.from + indent;
  if (start >= line.to) return null;
  let node = syntaxTree(state).resolveInner(start, 1);
  // Climb to the outermost node that starts at the line's first token.
  while (node.parent && node.parent.from === start && node.parent.parent) node = node.parent;
  if (node.from !== start) return null;
  const span = wholeLines(state, node.from, node.to);
  if (state.doc.lineAt(node.to).to !== span.to) return null;
  return { span, node };
}

function siblingStatement(state: EditorState, pos: number, up: boolean): LineSpan | null {
  const cur = statementAt(state, pos);
  if (!cur) return null;
  const tree = syntaxTree(state);
  let node = tree.resolveInner(cur.node.from, 1);
  while (node.parent && node.parent.from === cur.node.from && node.parent.parent) node = node.parent;
  let sib = up ? node.prevSibling : node.nextSibling;
  // Skip punctuation / comments-only siblings on the same line.
  while (sib && state.doc.lineAt(sib.from).number === state.doc.lineAt(node.from).number) sib = up ? sib.prevSibling : sib.nextSibling;
  if (!sib) return null;
  // Don't move a statement past its block's braces.
  if (/^[{}()[\]]$/.test(state.sliceDoc(sib.from, sib.to))) return null;
  const span = wholeLines(state, sib.from, sib.to);
  if (state.doc.lineAt(sib.from).from !== span.from) return null;
  return span;
}

function swapSpans(state: EditorState, a: LineSpan, b: LineSpan, caretOffset: number, up: boolean): TransactionSpec {
  // a is above b; the moved one is `up ? b : a`.
  const textA = state.sliceDoc(a.from, a.to);
  const textB = state.sliceDoc(b.from, b.to);
  const between = state.sliceDoc(a.to, b.from);
  const insert = textB + between + textA;
  const changes: ChangeSpec = { from: a.from, to: b.to, insert };
  const anchor = up ? a.from + caretOffset : a.from + textB.length + between.length + caretOffset;
  return { changes, selection: { anchor }, scrollIntoView: true, userEvent: "move.line" };
}

function moveStatement(up: boolean): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    if (state.selection.ranges.length === 1 && state.selection.main.empty) {
      const head = state.selection.main.head;
      const cur = statementAt(state, head);
      const sib = cur && siblingStatement(state, head, up);
      if (cur && sib && (cur.span.to - cur.span.from > 0)) {
        const caretOffset = head - cur.span.from;
        const spec = up ? swapSpans(state, sib, cur.span, caretOffset, true) : swapSpans(state, cur.span, sib, caretOffset, false);
        view.dispatch(spec);
        return true;
      }
    }
    return up ? moveLineUp(view) : moveLineDown(view);
  };
}

export const moveStatementUp = moveStatement(true);
export const moveStatementDown = moveStatement(false);

// --- complete statement -------------------------------------------------------

export const SEMICOLON_LANGS = new Set([
  "java", "c", "cpp", "csharp", "javascript", "javascriptreact", "typescript", "typescriptreact", "rust", "php",
  "dart", "objective-c", "objective-cpp", "groovy", "zig",
]);
/** Blocks close with a keyword (`end`) or by indentation: never complete them with braces. */
export const KEYWORD_BLOCK_LANGS = new Set([
  "python", "ruby", "lua", "elixir", "haskell", "shellscript", "julia", "erlang", "fsharp", "ocaml", "ocaml.interface",
  "yaml", "markdown", "plaintext", "makefile", "cmake", "toml", "ini", "properties", "sql", "r", "perl", "powershell",
]);
/** A line opening an indented body in `end` / layout languages (Ruby, Lua, Elixir, Haskell…). */
const KEYWORD_HEAD =
  /\b(do(\s*\|[^|]*\|)?|then|where|of)$|^\s*(def|defp|defmodule|class|module|function|local function|if|unless|elsif|elseif|else|while|until|for|case|begin)\b/;
const BLOCK_HEAD = /^\s*(if|else|for|while|do|switch|try|catch|finally|fn|fun|func|function|class|struct|enum|impl|trait|interface|object|match|when|loop|unsafe|mod|namespace)\b/;

/** Offset in `text` where a trailing line comment starts (outside string literals), else `text.length`. */
export function codeEnd(text: string, lineComment: string | undefined): number {
  if (!lineComment) return text.length;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (text.startsWith(lineComment, i)) return text.slice(0, i).trimEnd().length;
  }
  return text.length;
}

export function lineCommentToken(state: EditorState, pos: number): string | undefined {
  const tokens = state.languageDataAt<{ line?: string }>("commentTokens", pos)[0];
  return tokens?.line;
}

/**
 * The text-based Complete Current Statement (⌘⇧↵) on the caret line: a `;`
 * (before a trailing comment), a `{ }` block after a block header, `:` in
 * Python, then a new line. `null` on an empty line.
 */
export function completeStatementSpec(state: EditorState, language: string): TransactionSpec | null {
  const line = state.doc.lineAt(state.selection.main.head);
  const full = line.text.trimEnd();
  const trimmed = full.trim();
  if (!trimmed) return null;
  const comment = /^(\/\/|#|\*|\/\*|--)/.test(trimmed);
  const text = comment ? full : full.slice(0, codeEnd(full, lineCommentToken(state, line.from)));
  const unit = indentString(state, getIndentUnit(state));
  const baseIndent = /^\s*/.exec(line.text)![0];
  const br = state.lineBreak;
  const braces = !KEYWORD_BLOCK_LANGS.has(language);
  if (braces && !comment && BLOCK_HEAD.test(text) && !/[{;,]$/.test(text)) {
    const insert = ` {${br}${baseIndent}${unit}${br}${baseIndent}}`;
    const from = line.from + text.length;
    return {
      // A trailing comment moves to the end of the header line.
      changes: { from, to: line.from + full.length, insert: insert.slice(0, 2) + full.slice(text.length) + insert.slice(2) },
      selection: { anchor: from + 2 + full.length - text.length + br.length + baseIndent.length + unit.length },
      scrollIntoView: true,
      userEvent: "input.complete",
    };
  }
  let insert = "";
  if (SEMICOLON_LANGS.has(language) && !comment && text.trim() && !/[;{},:]$/.test(text)) insert = ";";
  if (language === "python" && BLOCK_HEAD.test(text.replace(/^\s*(def|elif)\b/, "if")) && !text.endsWith(":")) insert = ":";
  const opensBlock =
    text.endsWith("{") || insert === ":" || text.endsWith(":") || (KEYWORD_BLOCK_LANGS.has(language) && KEYWORD_HEAD.test(text) && !/^\s*module\b.*\bwhere$/.test(text));
  const nextIndent = baseIndent + (opensBlock ? unit : "");
  const indentHere = getIndentation(state, line.to);
  const newline = br + (indentHere !== null && !opensBlock ? indentString(state, indentHere) : nextIndent);
  const changes: ChangeSpec[] = [];
  if (insert) changes.push({ from: line.from + text.length, insert });
  changes.push({ from: line.from + full.length, to: line.to, insert: newline });
  return {
    changes,
    selection: { anchor: line.from + full.length + insert.length + newline.length },
    scrollIntoView: true,
    userEvent: "input.complete",
  };
}

/** ⌘⇧↵: finish the current line (closing `;` or a `{ }` block) and move to the next line. */
export function completeStatement(language: string): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const spec = completeStatementSpec(view.state, language);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  };
}

// --- helpers -------------------------------------------------------------------

export function selectRange(view: EditorView, range: SelectionRange | { from: number; to: number }, center = true) {
  view.dispatch({
    selection: EditorSelection.single(range.from, range.to),
    effects: center ? EditorView.scrollIntoView(range.from, { y: "center" }) : undefined,
    scrollIntoView: !center,
    userEvent: "select",
  });
}

// --- comments ------------------------------------------------------------------------

export { commentLine } from "./comments";

// --- smart keys ------------------------------------------------------------------

function newLineCommand(before: boolean): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    if (before) {
      // A new line above each caret line, indented like that line (one level deeper above a closing bracket).
      const unit = indentString(state, getIndentUnit(state));
      const tr = state.changeByRange((r) => {
        const line = state.doc.lineAt(r.head);
        const own = /^[ \t]*/.exec(line.text)![0];
        // Without a parsed language there's nothing to compute from: keep the line's indent.
        const computed = syntaxTree(state).length ? getIndentation(state, line.from) : null;
        let indent = computed !== null ? indentString(state, computed) : own;
        if (/^\s*[)\]}]/.test(line.text) && indent.length <= own.length) indent = own + unit;
        return { changes: { from: line.from, insert: indent + state.lineBreak }, range: EditorSelection.cursor(line.from + indent.length) };
      });
      view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
      return true;
    }
    // Put each caret at the end of its line, then break and indent there.
    const atEnd = state.update({
      selection: EditorSelection.create(
        state.selection.ranges.map((r) => EditorSelection.cursor(state.doc.lineAt(r.head).to)),
        state.selection.mainIndex,
      ),
    }).state;
    let result: Transaction | null = null;
    insertNewlineAndIndent({ state: atEnd, dispatch: (tr) => (result = tr) });
    if (!result) return false;
    const tr: Transaction = result;
    view.dispatch({ changes: tr.changes, selection: tr.selection, scrollIntoView: true, userEvent: "input" });
    return true;
  };
}

/** ⇧↵: Start New Line (below the caret line, whatever the caret column). */
export const startNewLine = newLineCommand(false);
/** ⌘⌥↵: Start New Line Before Current. */
export const startNewLineBefore = newLineCommand(true);

/** ⌃⇧J: Join Lines — the next line (or the selected lines) joined with single spaces. */
export const joinLines: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const tr = state.changeByRange((r) => {
    const first = state.doc.lineAt(r.from);
    let last = state.doc.lineAt(r.to);
    if (last.number === first.number || (!r.empty && r.to === last.from && last.number - 1 === first.number)) {
      if (first.number === state.doc.lines) return { range: r };
      last = state.doc.line(first.number + 1);
    } else if (!r.empty && r.to === last.from) {
      last = state.doc.line(last.number - 1);
    }
    const changes: ChangeSpec[] = [];
    let caret = r.head;
    for (let n = first.number; n < last.number; n++) {
      const cur = state.doc.line(n);
      const next = state.doc.line(n + 1);
      const trail = /[ \t]*$/.exec(cur.text)![0].length;
      const lead = /^[ \t]*/.exec(next.text)![0].length;
      const nextText = next.text.slice(lead);
      // Drop the comment marker of a joined line comment (`// a` + `// b` → `// a b`).
      const comment = /^(\/\/+|#+|--)\s?/.exec(nextText);
      const curTrim = cur.text.slice(0, cur.length - trail);
      const skip = comment && new RegExp(`(^|\\s)${comment[1]!.replace(/[-/#]/g, "\\$&")}`).test(curTrim) ? comment[0].length : 0;
      const sep = !curTrim.length || !nextText.length || /[([{]$/.test(curTrim) || /^[)\]}.,;]/.test(nextText.slice(skip)) ? "" : " ";
      changes.push({ from: cur.to - trail, to: next.from + lead + skip, insert: sep });
      if (n === first.number) caret = cur.to - trail;
    }
    const set = state.changes(changes);
    return { changes: set, range: r.empty ? EditorSelection.cursor(set.mapPos(caret, -1)) : EditorSelection.range(set.mapPos(r.from, 1), set.mapPos(r.to, -1)) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.join" }));
  return true;
};

/** Escape sequences keep their case: `\n` must not become `\N`. */
function caseOf(state: EditorState, from: number, to: number, lower: boolean): string {
  const text = state.sliceDoc(from, to);
  const conv = (t: string) => (lower ? t.toLowerCase() : t.toUpperCase());
  const keep: Array<[number, number]> = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (/Escape/.test(n.type.name)) keep.push([Math.max(n.from, from) - from, Math.min(n.to, to) - from]);
    },
  });
  if (!keep.length) return conv(text);
  let out = "";
  let pos = 0;
  for (const [a, b] of keep) {
    if (a < pos) continue;
    out += conv(text.slice(pos, a)) + text.slice(a, b);
    pos = b;
  }
  return out + conv(text.slice(pos));
}

/**
 * ⌘⇧U: Toggle Case of the selections (the word at a caret, which stays
 * selected): lower case when any of them has an upper-case letter, else upper.
 */
export const toggleCase: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const targets = state.selection.ranges.map((r) => (r.empty ? state.wordAt(r.head) : r));
  const lower = targets.some((t) => t && state.sliceDoc(t.from, t.to) !== state.sliceDoc(t.from, t.to).toLowerCase());
  const tr = state.changeByRange((r) => {
    const t = targets[state.selection.ranges.indexOf(r)];
    if (!t) return { range: r };
    const insert = caseOf(state, t.from, t.to, lower);
    const range = r.empty ? EditorSelection.range(t.from, t.from + insert.length) : EditorSelection.range(r.anchor, r.head);
    return { changes: { from: t.from, to: t.to, insert }, range };
  });
  view.dispatch(state.update(tr, { userEvent: "input.case" }));
  return true;
};

/** ⌥⇧G: Add Carets to Ends of Selected Lines. */
export const addCaretsToLineEnds: Command = (view) => {
  const { state } = view;
  const ranges: SelectionRange[] = [];
  for (const r of state.selection.ranges) {
    if (r.empty) {
      ranges.push(r);
      continue;
    }
    const first = state.doc.lineAt(r.from).number;
    let last = state.doc.lineAt(r.to).number;
    if (last > first && state.doc.lineAt(r.to).from === r.to) last--;
    for (let n = first; n <= last; n++) ranges.push(EditorSelection.cursor(state.doc.line(n).to));
  }
  if (ranges.length === state.selection.ranges.length && state.selection.ranges.every((r) => r.empty)) return false;
  view.dispatch({ selection: EditorSelection.create(ranges, ranges.length - 1), scrollIntoView: true, userEvent: "select" });
  return true;
};

/** ⌃⇧G: Unselect Occurrence — drops the most recently added selection. */
export const unselectOccurrence: Command = (view) => {
  const sel = view.state.selection;
  if (sel.ranges.length < 2) return false;
  const ranges = sel.ranges.filter((_, i) => i !== sel.mainIndex);
  // The previous occurrence becomes main: the one closest before the removed one, else the last.
  const removed = sel.main.from;
  let main = ranges.length - 1;
  for (let i = ranges.length - 1; i >= 0; i--)
    if (ranges[i]!.from < removed) {
      main = i;
      break;
    }
  view.dispatch({ selection: EditorSelection.create(ranges, main), scrollIntoView: true, userEvent: "select" });
  return true;
};
