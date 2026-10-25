/**
 * CodeMirror's default keymap minus the bindings that clash with IntelliJ IDEA.
 * Those keys belong to IDE actions instead (keymaps in `platform/keymaps/`):
 * ⌘/Ctrl+Enter is Split Line, Ctrl+M / ⌃L Scroll to Center, Ctrl+[ / ] code
 * block navigation, ⌥⌘↑↓ / Ctrl+Alt+↑↓ Previous / Next Occurrence.
 */
import type { KeyBinding } from "@codemirror/view";
import {
  addCursorAbove,
  addCursorBelow,
  defaultKeymap,
  historyKeymap,
  indentLess,
  indentMore,
  insertBlankLine,
  redo,
  selectLine,
  toggleTabFocusMode,
} from "@codemirror/commands";

const DROPPED = new Set<unknown>([
  insertBlankLine, // Mod-Enter
  toggleTabFocusMode, // Ctrl-m / Shift-Alt-m
  selectLine, // Alt-l / Ctrl-l
  addCursorAbove, // Mod-Alt-ArrowUp
  addCursorBelow, // Mod-Alt-ArrowDown
  indentLess, // Mod-[
  indentMore, // Mod-]
]);

export const editorBaseKeymap: readonly KeyBinding[] = [
  ...defaultKeymap.filter((b) => !DROPPED.has(b.run)),
  ...historyKeymap,
  // IDEA's Windows Redo is Ctrl+Shift+Z (Ctrl+Y is Delete Line); CodeMirror only binds it on macOS and Linux.
  { win: "Ctrl-Shift-z", run: redo, preventDefault: true },
];
