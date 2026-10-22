/**
 * Edit › Column Selection Mode (⇧⌘8): while on, a plain mouse drag and
 * ⇧+arrows make rectangular (block) selections, one range per line.
 */
import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, rectangularSelection } from "@codemirror/view";

interface Block {
  anchorLine: number;
  anchorCol: number;
  headLine: number;
  headCol: number;
}

interface ColumnState {
  on: boolean;
  /** The block ⇧+arrows extend; reset by any other selection change. */
  block: Block | null;
}

export const setColumnMode = StateEffect.define<boolean>();
const setBlock = StateEffect.define<Block>();

export const columnModeField = StateField.define<ColumnState>({
  create: () => ({ on: false, block: null }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setColumnMode)) next = { on: e.value, block: null };
      else if (e.is(setBlock)) return { ...next, block: e.value };
    }
    if (next.block && (tr.docChanged || tr.selection)) next = { ...next, block: null };
    return next;
  },
});

export function isColumnMode(state: EditorState): boolean {
  return state.field(columnModeField, false)?.on ?? false;
}

export function toggleColumnMode(view: EditorView): boolean {
  view.dispatch({ effects: setColumnMode.of(!isColumnMode(view.state)) });
  return true;
}

/** One range per line from the anchor column to the head column (clamped to each line). */
export function blockSelection(state: EditorState, b: Block): EditorSelection {
  const ranges = [];
  const step = b.headLine >= b.anchorLine ? 1 : -1;
  for (let n = b.anchorLine; ; n += step) {
    const line = state.doc.line(n);
    ranges.push(EditorSelection.range(line.from + Math.min(b.anchorCol, line.length), line.from + Math.min(b.headCol, line.length)));
    if (n === b.headLine) break;
  }
  return EditorSelection.create(ranges, ranges.length - 1);
}

/** ⇧+arrow in column mode: moves the block's head by a line / column. */
export function extendBlock(view: EditorView, dLine: number, dCol: number): boolean {
  const state = view.state;
  const field = state.field(columnModeField, false);
  if (!field?.on) return false;
  let b = field.block;
  if (!b) {
    const main = state.selection.main;
    const a = state.doc.lineAt(main.anchor);
    const h = state.doc.lineAt(main.head);
    b = { anchorLine: a.number, anchorCol: main.anchor - a.from, headLine: h.number, headCol: main.head - h.from };
  }
  const headLine = Math.max(1, Math.min(state.doc.lines, b.headLine + dLine));
  const next = { ...b, headLine, headCol: Math.max(0, b.headCol + dCol) };
  view.dispatch({
    selection: blockSelection(state, next),
    effects: setBlock.of(next),
    scrollIntoView: true,
    userEvent: "select.column",
  });
  return true;
}

function viewOf(e: MouseEvent): EditorView | null {
  return e.target instanceof HTMLElement ? EditorView.findFromDOM(e.target) : null;
}

export const columnModeExtension: Extension = [
  columnModeField,
  rectangularSelection({
    eventFilter: (e) => {
      if (e.button !== 0 || e.altKey || e.metaKey || e.ctrlKey) return false;
      const view = viewOf(e);
      return !!view && isColumnMode(view.state);
    },
  }),
  Prec.high(
    keymap.of([
      { key: "Shift-ArrowUp", run: (v) => extendBlock(v, -1, 0) },
      { key: "Shift-ArrowDown", run: (v) => extendBlock(v, 1, 0) },
      { key: "Shift-ArrowLeft", run: (v) => extendBlock(v, 0, -1) },
      { key: "Shift-ArrowRight", run: (v) => extendBlock(v, 0, 1) },
    ]),
  ),
  EditorView.editorAttributes.compute([columnModeField], (s): Record<string, string> => (isColumnMode(s) ? { class: "cm-openidea-columnMode" } : {})),
];
