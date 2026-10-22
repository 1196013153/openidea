/**
 * IDEA mouse multi-caret gestures (macOS keymap): ⌥⇧click adds a caret (or
 * removes the one under the pointer), ⌥⇧drag adds a selection, ⌥drag makes a
 * column (rectangular) selection.
 */
import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, rectangularSelection, type MouseSelectionStyle } from "@codemirror/view";

/** The selection after ⌥⇧click / drag from `anchor` to `head` on top of `start`. */
export function toggleCaret(start: EditorSelection, anchor: number, head: number): EditorSelection {
  if (anchor === head) {
    const hit = start.ranges.findIndex((r) => r.empty && r.head === head);
    if (hit >= 0 && start.ranges.length > 1) {
      const ranges = start.ranges.filter((_, i) => i !== hit);
      return EditorSelection.create(ranges, Math.min(start.mainIndex, ranges.length - 1));
    }
  }
  return start.addRange(EditorSelection.range(anchor, head));
}

const addCaretStyle = EditorView.mouseSelectionStyle.of((view, event): MouseSelectionStyle | null => {
  if (event.button !== 0 || !event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey) return null;
  let start = view.state.selection;
  const anchor = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  return {
    get(cur) {
      const head = view.posAtCoords({ x: cur.clientX, y: cur.clientY }, false);
      return toggleCaret(start, anchor, head);
    },
    update(update) {
      if (update.docChanged) start = start.map(update.changes);
    },
  };
});

export const multiCaretMouse: Extension = [
  addCaretStyle,
  // CodeMirror's default (⌘click) would clash with ⌘click navigation.
  EditorView.clickAddsSelectionRange.of(() => false),
  rectangularSelection({ eventFilter: (e) => e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey }),
];
