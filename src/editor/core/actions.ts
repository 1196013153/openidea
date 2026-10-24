/** Editor actions (ids from keymaps/intellij-macos.ts). */
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { addCursorAbove, addCursorBelow, deleteLine, moveLineDown, moveLineUp, toggleBlockComment } from "@codemirror/commands";
import { foldAll, syntaxTree, toggleFold, unfoldAll } from "@codemirror/language";
import { acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { executeAction, registerActions, type Action } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { editorController, useGotoLine, useTabs } from "./controller";
import {
  addCaretNextOccurrence,
  addCaretsToLineEnds,
  commentLine,
  completeStatement,
  duplicateLineOrSelection,
  joinLines,
  moveStatementDown,
  moveStatementUp,
  selectAllOccurrences,
  startNewLine,
  startNewLineBefore,
  toggleCase,
  unselectOccurrence,
} from "./cm/editing";
import { emptyStack, extendSelection, shrinkSelection, type SelectionStack, type SimpleRange } from "./model/selectionStack";
import type { EditorSlot } from "./model/slot";
import { findAgain, openFindBar } from "./view/FindBar";
import { foldAtCaret, foldSelection, unfoldAtCaret } from "./cm/folding";
import { reverseLines, sortLines } from "./cm/lines";
import { cursorCodeBlockEnd, cursorCodeBlockStart, scrollToCenter, splitLine } from "./cm/caretCommands";
import { isColumnMode, toggleColumnMode } from "./cm/columnMode";
import { pasteAsPlainText, pasteFromHistory, unwrapAtCaret } from "./extras";
import { cyclicExpandWord } from "./wordCompletion";
import { qualifiedReference } from "./copyReference";
import { symbolChain } from "./view/outline";
import { recordClipboard } from "./clipboardHistory";
import { useOutline } from "./model/document";
import { useProject } from "@/platform/project";
import { toggleReadOnly } from "./fileAttributes";
import { openNavBarPopup } from "./view/NavBarPopup";
import {
  cachedStructureQueries,
  completeStatementStructural,
  hasLezerTree,
  moveStatementStructural,
  type StructureQueries,
} from "./cm/structural";
import type { DocModel } from "./model/document";
import { structure } from "@/editor/structure";

/** Text-editing actions: the editor has focus, or a popup (Find Action) runs them on it. */
export const TEXT_WHEN = "editorTextFocus || textEditorActive && popupOpen";
const EDITOR_WHEN = "textEditorActive && (editorFocus || popupOpen || !toolWindowFocus)";
const TABS_WHEN = "editorTabsOpen && !toolWindowFocus";

function activeSlot(): EditorSlot | null {
  const slot = editorController().activeSlot;
  return slot && !slot.disposed ? slot : null;
}

function withView(run: (view: EditorView, slot: EditorSlot) => unknown) {
  return () => {
    const slot = activeSlot();
    if (!slot?.view) return;
    run(slot.view, slot);
    if (!slot.view.hasFocus && !getContext().popupOpen) slot.view.focus();
  };
}

// --- extend / shrink selection ---------------------------------------------------

/** One stack per selection range (by index): ⌥↑ / ⌥↓ work on every caret. */
const stacks = new WeakMap<EditorSlot, SelectionStack[]>();

/** Syntax-tree candidates when the backend has nothing (or the language isn't parsed there). */
export function syntaxCandidates(state: EditorState, sel: SimpleRange): SimpleRange[] {
  const out: SimpleRange[] = [];
  const word = state.wordAt(sel.from);
  if (word) out.push({ from: word.from, to: word.to });
  const tree = syntaxTree(state);
  for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(sel.from, 1); node; node = node.parent) {
    out.push({ from: node.from, to: node.to });
    const text = state.sliceDoc(node.from, Math.min(node.to, node.from + 1)) + state.sliceDoc(Math.max(node.from, node.to - 1), node.to);
    if (/^[([{"'`][)\]}"'`]$/.test(text) && node.to - node.from > 2) out.push({ from: node.from + 1, to: node.to - 1 });
  }
  const line = state.doc.lineAt(sel.from);
  const endLine = state.doc.lineAt(sel.to);
  const indent = /^\s*/.exec(line.text)![0].length;
  out.push({ from: line.from + indent, to: endLine.to }, { from: line.from, to: endLine.to }, { from: 0, to: state.doc.length });
  return out;
}

function rangesFromBackend(state: EditorState, ranges: Array<{ start: { line: number; col: number }; end: { line: number; col: number } }>): SimpleRange[] {
  const off = (p: { line: number; col: number }) => {
    if (p.line + 1 > state.doc.lines) return state.doc.length;
    const l = state.doc.line(p.line + 1);
    return Math.min(l.from + p.col, l.to);
  };
  return ranges.map((r) => ({ from: off(r.start), to: off(r.end) }));
}

export interface BackendChain {
  /** `DocModel.changeCounter` when the chain was computed. */
  counter: number;
  /** Offset the backend was asked at. */
  pos: number;
  ranges: SimpleRange[];
}

/**
 * The backend chain of a previous extend answers again while the document is
 * unchanged and the selection still covers its position: every node around
 * the selection is around that position too. Repeated ⌥↑ then needs no IPC.
 */
export function reusableChain(chain: BackendChain | undefined, counter: number, current: SimpleRange): SimpleRange[] | null {
  return chain && chain.counter === counter && chain.pos >= current.from && chain.pos <= current.to ? chain.ranges : null;
}

const chains = new WeakMap<EditorSlot, BackendChain>();

/** Backend candidates around `current` (the cached chain for repeated extends of one range). */
async function backendCandidates(slot: EditorSlot, current: SimpleRange, cache: boolean): Promise<SimpleRange[]> {
  const model = slot.model;
  const cached = cache ? reusableChain(chains.get(slot), model.changeCounter, current) : null;
  if (cached) return cached;
  try {
    await model.sync.whenIdle();
    const counter = model.changeCounter;
    const ranges = await model.manager.backend.selectionRanges(model.doc, current.from);
    if (counter !== model.changeCounter || !slot.view) return [];
    const candidates = rangesFromBackend(slot.view.state, ranges);
    if (cache) chains.set(slot, { counter, pos: current.from, ranges: candidates });
    return candidates;
  } catch {
    return []; // fall back to the syntax tree
  }
}

async function extend(slot: EditorSlot) {
  const view = slot.view;
  if (!view) return;
  const before = view.state.selection;
  const currents = before.ranges.map((r) => ({ from: r.from, to: r.to }));
  const candidates = await Promise.all(currents.map((c, i) => backendCandidates(slot, c, i === before.mainIndex)));
  const v = slot.view;
  if (!v || !v.state.selection.eq(before)) return;
  const prev = stacks.get(slot) ?? [];
  const results = currents.map((c, i) =>
    extendSelection(prev[i] ?? emptyStack(), c, [...candidates[i]!, ...syntaxCandidates(v.state, c)]),
  );
  stacks.set(slot, results.map((r) => r.state));
  if (!results.some((r) => r.next)) return;
  const ranges = results.map((r, i) => (r.next ? EditorSelection.range(r.next.from, r.next.to) : before.ranges[i]!));
  v.dispatch({ selection: EditorSelection.create(ranges, before.mainIndex), scrollIntoView: true, userEvent: "select.extend" });
}

/** Extend / shrink run in order: a quick ⌥↑⌥↑ extends twice although extending waits for the backend. */
const selectionQueue = new WeakMap<EditorSlot, Promise<void>>();

function queueSelection(slot: EditorSlot, step: (slot: EditorSlot) => void | Promise<void>) {
  const next = (selectionQueue.get(slot) ?? Promise.resolve()).then(() => step(slot)).catch(() => {});
  selectionQueue.set(slot, next);
  return next;
}

function shrink(slot: EditorSlot) {
  const view = slot.view;
  if (!view) return;
  const sel = view.state.selection;
  const prev = stacks.get(slot) ?? [];
  const results = sel.ranges.map((r, i) => shrinkSelection(prev[i] ?? emptyStack(), { from: r.from, to: r.to }));
  stacks.set(slot, results.map((r) => r.state));
  if (!results.some((r) => r.next)) return;
  const ranges = results.map((r, i) => (r.next ? EditorSelection.range(r.next.from, r.next.to) : sel.ranges[i]!));
  view.dispatch({ selection: EditorSelection.create(ranges, sel.mainIndex), scrollIntoView: true, userEvent: "select.shrink" });
}

// --- structural editing without a Lezer tree ------------------------------------------

const structureQueries = new WeakMap<DocModel, StructureQueries>();

function queriesFor(model: DocModel): StructureQueries {
  let q = structureQueries.get(model);
  if (!q) {
    q = cachedStructureQueries({
      stamp: () => model.changeCounter,
      synced: () => model.sync.whenIdle(),
      fetchRanges: (pos) => structure.structuralRanges(model.doc, pos),
      fetchErrors: () => structure.syntaxErrors(model.doc),
    });
    structureQueries.set(model, q);
  }
  return q;
}

async function hasStructure(language: string): Promise<boolean> {
  try {
    return (await structure.support(language)).tree;
  } catch {
    return false;
  }
}

/** Structural edits wait for the backend: run them in order so a quick ⇧⌘↑⇧⌘↑ moves twice. */
const editQueue = new WeakMap<EditorSlot, Promise<void>>();

function queueEdit(slot: EditorSlot, step: () => Promise<unknown>) {
  const next = (editQueue.get(slot) ?? Promise.resolve()).then(step).then(
    () => {},
    (e: unknown) => console.warn("structural edit failed", e),
  );
  editQueue.set(slot, next);
  return next;
}

/** Move Statement: the Lezer tree where there is one, else the tree-sitter structure, else the line. */
function moveStatement(view: EditorView, slot: EditorSlot, up: boolean) {
  const sel = view.state.selection;
  if (hasLezerTree(view.state) || sel.ranges.length > 1 || !sel.main.empty) {
    return up ? moveStatementUp(view) : moveStatementDown(view);
  }
  void queueEdit(slot, async () => {
    const v = slot.view;
    if (!v) return;
    const language = slot.model.getMeta().language;
    if ((await hasStructure(language)) && (await moveStatementStructural(v, up, queriesFor(slot.model))) !== "fallback") return;
    if (slot.view === v) (up ? moveLineUp : moveLineDown)(v);
  });
}

/**
 * Complete Current Statement: tree-sitter knows what is missing where (and
 * which multi-line statement the caret is in) for stream-mode languages, and
 * places Java's `;` better than the line heuristics; the heuristics finish the line.
 * With the completion lookup open, its selected item is inserted first (IDEA).
 */
function completeCurrentStatement(view: EditorView, slot: EditorSlot) {
  if (completionStatus(view.state) === "active") acceptCompletion(view);
  const language = slot.model.getMeta().language;
  const sel = view.state.selection;
  if ((hasLezerTree(view.state) && language !== "java") || sel.ranges.length > 1) return completeStatement(language)(view);
  void queueEdit(slot, async () => {
    const v = slot.view;
    if (!v || v.state.readOnly) return;
    if ((await hasStructure(language)) && (await completeStatementStructural(v, language, queriesFor(slot.model))) !== "fallback") return;
    if (slot.view === v) completeStatement(language)(v);
  });
}

// --- cyclic expand word / copy reference ------------------------------------------------

/** Text of the other open documents for Cyclic Expand Word (bounded). */
function otherEditorTexts(current: EditorSlot): string[] {
  const out: string[] = [];
  const seen = new Set([current.model.path]);
  let budget = 4 * 1024 * 1024;
  for (const slot of editorController().slots.values()) {
    if (slot.disposed || seen.has(slot.model.path)) continue;
    seen.add(slot.model.path);
    const doc = slot.currentState().doc;
    if (doc.length > budget) continue;
    budget -= doc.length;
    out.push(doc.toString());
  }
  return out;
}

function expandWord(view: EditorView, slot: EditorSlot, direction: "backward" | "forward") {
  const message = cyclicExpandWord(view, direction, () => otherEditorTexts(slot));
  if (message) void executeAction("editor.showHint", { text: message });
}

function copyReference(view: EditorView, slot: EditorSlot) {
  const state = view.state;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const meta = slot.model.getMeta();
  const outline = useOutline.getState()[slot.model.path] ?? [];
  const reference = qualifiedReference({
    language: meta.language,
    path: slot.model.path,
    root: useProject.getState().project?.root ?? null,
    text: state.doc.toString(),
    chain: symbolChain(outline, line.number - 1, head - line.from).map((i) => i.name),
    line: line.number - 1,
  });
  recordClipboard(reference);
  void navigator.clipboard?.writeText(reference).catch(() => {});
  void executeAction("editor.showHint", { text: `Copied reference: ${reference}` });
}

// ---------------------------------------------------------------------------------

export function registerEditorActions(): () => void {
  const ctrl = editorController();
  const text = (id: string, title: string, run: (view: EditorView, slot: EditorSlot) => unknown, extra: Partial<Action> = {}): Action => ({
    id,
    title,
    category: "Code",
    when: TEXT_WHEN,
    run: withView(run),
    ...extra,
  });
  const activePaneTab = () => {
    const s = useTabs.getState();
    const pane = s.panes[s.activePane];
    return pane?.active ? { paneId: pane.id, tabId: pane.active } : null;
  };
  return registerActions([
    text("code.commentLine", "Comment with Line Comment", (v) => commentLine(v)),
    text("code.commentBlock", "Comment with Block Comment", (v) => toggleBlockComment(v)),
    text("code.duplicateLine", "Duplicate Line or Selection", (v) => duplicateLineOrSelection(v)),
    text("code.deleteLine", "Delete Line", (v) => deleteLine(v)),
    text("code.moveLineUp", "Move Line Up", (v) => moveLineUp(v)),
    text("code.moveLineDown", "Move Line Down", (v) => moveLineDown(v)),
    text("code.moveStatementUp", "Move Statement Up", (v, slot) => moveStatement(v, slot, true)),
    text("code.moveStatementDown", "Move Statement Down", (v, slot) => moveStatement(v, slot, false)),
    text("code.extendSelection", "Extend Selection", (_v, slot) => void queueSelection(slot, extend), { category: "Edit" }),
    text("code.shrinkSelection", "Shrink Selection", (_v, slot) => void queueSelection(slot, shrink), { category: "Edit" }),
    text("code.fold", "Collapse", (v) => foldAtCaret(v), { category: "Folding", keywords: ["fold"] }),
    text("code.unfold", "Expand", (v) => unfoldAtCaret(v), { category: "Folding", keywords: ["unfold"] }),
    text("code.foldToggle", "Toggle Fold", (v) => toggleFold(v), { category: "Folding" }),
    text("code.cyclicExpandWord", "Cyclic Expand Word", (v, slot) => expandWord(v, slot, "backward"), {
      keywords: ["hippie", "complete word", "dabbrev"],
    }),
    text("code.cyclicExpandWordBackward", "Cyclic Expand Word (Backward)", (v, slot) => expandWord(v, slot, "forward"), {
      keywords: ["hippie", "complete word", "dabbrev"],
    }),
    text("editor.copyReference", "Copy Reference", (v, slot) => copyReference(v, slot), {
      category: "Edit",
      keywords: ["fully qualified name", "fqn", "copy path"],
    }),
    text("code.pasteAsPlainText", "Paste as Plain Text", (v) => pasteAsPlainText(v), { category: "Edit", icon: "paste" }),
    {
      id: "editor.toggleSoftWrap",
      title: "Soft-Wrap",
      category: "View",
      icon: "soft-wrap",
      keywords: ["word wrap", "line wrap"],
      when: "textEditorActive",
      toggled: () => activeSlot()?.model.softWrapOn() ?? false,
      run: () => activeSlot()?.model.toggleSoftWrap(),
    },
    text("code.foldAll", "Collapse All", (v) => foldAll(v), { category: "Folding", icon: "collapse-all" }),
    text("code.unfoldAll", "Expand All", (v) => unfoldAll(v), { category: "Folding", icon: "expand-all" }),
    text("code.addCaretNextOccurrence", "Add Selection for Next Occurrence", (v) => addCaretNextOccurrence(v), { category: "Edit" }),
    text("code.selectAllOccurrences", "Select All Occurrences", (v) => selectAllOccurrences(v), { category: "Edit" }),
    text("code.completeStatement", "Complete Current Statement", (v, slot) => completeCurrentStatement(v, slot)),
    text("code.startNewLine", "Start New Line", (v) => startNewLine(v)),
    text("code.startNewLineBefore", "Start New Line Before Current", (v) => startNewLineBefore(v)),
    text("code.splitLine", "Split Line", (v) => splitLine(v)),
    text("editor.scrollToCenter", "Scroll to Center", (v) => scrollToCenter(v), { category: "Editor Actions" }),
    text("editor.codeBlockStart", "Move Caret to Code Block Start", (v) => cursorCodeBlockStart(v), { category: "Editor Actions" }),
    text("editor.codeBlockEnd", "Move Caret to Code Block End", (v) => cursorCodeBlockEnd(v), { category: "Editor Actions" }),
    text("editor.cloneCaretAbove", "Clone Caret Above", (v) => addCursorAbove(v), { category: "Editor Actions" }),
    text("editor.cloneCaretBelow", "Clone Caret Below", (v) => addCursorBelow(v), { category: "Editor Actions" }),
    text("code.joinLines", "Join Lines", (v) => joinLines(v)),
    text("code.toggleCase", "Toggle Case", (v) => toggleCase(v), { keywords: ["upper", "lower"] }),
    text("code.addCaretsToLineEnds", "Add Carets to Ends of Selected Lines", (v) => addCaretsToLineEnds(v), { category: "Edit" }),
    text("code.unselectOccurrence", "Unselect Occurrence", (v) => unselectOccurrence(v), { category: "Edit" }),
    text("code.pasteFromHistory", "Paste from History…", (v) => pasteFromHistory(v), { category: "Edit", keywords: ["clipboard", "paste multiple"] }),
    text("code.sortLines", "Sort Lines", (v) => sortLines(v), { category: "Edit" }),
    text("code.reverseLines", "Reverse Lines", (v) => reverseLines(v), { category: "Edit" }),
    text("code.unwrap", "Unwrap/Remove…", (_v, slot) => void unwrapAtCaret(slot), { keywords: ["unwrap", "remove if"] }),
    text("code.foldSelection", "Fold Selection / Remove Region", (v) => foldSelection(v), { category: "Folding" }),
    {
      id: "editor.toggleColumnSelection",
      title: "Column Selection Mode",
      category: "Edit",
      keywords: ["block selection", "rectangular selection"],
      when: "textEditorActive",
      toggled: () => {
        const view = activeSlot()?.view;
        return view ? isColumnMode(view.state) : false;
      },
      run: withView((v) => toggleColumnMode(v)),
    },
    {
      id: "file.reloadFromDisk",
      title: "Reload from Disk",
      category: "File",
      icon: "refresh",
      when: "projectOpen",
      keywords: ["synchronize", "refresh", "revert"],
      run: ({ arg }) => {
        const paths = typeof arg === "string" ? [arg] : Array.isArray(arg) ? arg.filter((p): p is string => typeof p === "string") : [];
        const active = ctrl.activePath();
        return ctrl.reloadFromDisk(paths.length ? paths : active ? [active] : []);
      },
    },
    {
      id: "file.toggleReadOnly",
      title: "Toggle Read-only Attribute",
      category: "File",
      keywords: ["make file writable", "make file read-only", "lock"],
      when: "textEditorActive",
      run: () => {
        const slot = activeSlot();
        if (slot) toggleReadOnly(slot.model);
      },
    },
    {
      id: "find.inFile",
      title: "Find",
      category: "Find",
      icon: "search",
      when: EDITOR_WHEN,
      run: () => openFindBar(useTabs.getState().activePane, false),
    },
    {
      id: "find.replaceInFile",
      title: "Replace",
      category: "Find",
      icon: "replace",
      when: EDITOR_WHEN,
      run: () => openFindBar(useTabs.getState().activePane, true),
    },
    {
      id: "find.next",
      title: "Find Next Occurrence",
      category: "Find",
      icon: "arrow-down",
      when: EDITOR_WHEN,
      run: () => findAgain(useTabs.getState().activePane, true),
    },
    {
      id: "find.previous",
      title: "Find Previous Occurrence",
      category: "Find",
      icon: "arrow-up",
      when: EDITOR_WHEN,
      run: () => findAgain(useTabs.getState().activePane, false),
    },
    {
      id: "navigate.gotoLine",
      title: "Go to Line:Column…",
      category: "Navigate",
      when: EDITOR_WHEN,
      run: () => useGotoLine.setState({ open: true }),
    },
    {
      id: "navigate.back",
      title: "Back",
      category: "Navigate",
      icon: "arrow-left",
      run: () => ctrl.back(),
    },
    {
      id: "navigate.forward",
      title: "Forward",
      category: "Navigate",
      icon: "arrow-right",
      run: () => ctrl.forward(),
    },
    {
      id: "navigate.navigationBar",
      title: "Jump to Navigation Bar",
      category: "Navigate",
      keywords: ["breadcrumbs"],
      when: "projectOpen",
      run: () => {
        if (activeSlot()) return openNavBarPopup();
        // No editor: the status bar breadcrumbs (StatusItems › Breadcrumbs) take focus.
        const crumbs = document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Breadcrumbs"] button');
        crumbs[crumbs.length - 1]?.focus();
      },
    },
    {
      id: "navigate.lastEditLocation",
      title: "Last Edit Location",
      category: "Navigate",
      when: "projectOpen",
      run: () => void ctrl.lastEditLocation(),
    },
    {
      id: "navigate.nextEditLocation",
      title: "Next Edit Location",
      category: "Navigate",
      when: "projectOpen",
      run: () => void ctrl.nextEditLocation(),
    },
    {
      id: "editor.closeTab",
      title: "Close Tab",
      category: "Window",
      icon: "close",
      when: "(editorTabsOpen || editorSplit) && !toolWindowFocus",
      run: () => ctrl.closeActiveTab(),
    },
    {
      id: "editor.closeOtherTabs",
      title: "Close Other Tabs",
      category: "Window",
      when: TABS_WHEN,
      run: () => {
        const t = activePaneTab();
        if (t) ctrl.closeOthers(t.paneId, t.tabId);
      },
    },
    {
      id: "editor.closeAllTabs",
      title: "Close All Tabs",
      category: "Window",
      when: "editorTabsOpen",
      run: () => ctrl.closeEverything(),
    },
    {
      id: "editor.pinTab",
      title: "Pin / Unpin Tab",
      category: "Window",
      icon: "pin",
      when: TABS_WHEN,
      run: () => {
        const t = activePaneTab();
        if (t) ctrl.togglePin(t.paneId, t.tabId);
      },
    },
    {
      id: "editor.reopenClosedTab",
      title: "Reopen Closed Tab",
      category: "Window",
      run: () => ctrl.reopenClosed(),
    },
    { id: "editor.nextTab", title: "Select Next Tab", category: "Window", when: TABS_WHEN, run: () => ctrl.cycle(1) },
    { id: "editor.prevTab", title: "Select Previous Tab", category: "Window", when: TABS_WHEN, run: () => ctrl.cycle(-1) },
    {
      id: "editor.splitRight",
      title: "Split Right",
      category: "Window",
      icon: "split",
      when: "editorTabsOpen",
      run: () => ctrl.split(useTabs.getState().activePane, "row"),
    },
    {
      id: "editor.splitDown",
      title: "Split Down",
      category: "Window",
      icon: "split-horizontal",
      when: "editorTabsOpen",
      run: () => ctrl.split(useTabs.getState().activePane, "column"),
    },
    {
      id: "editor.moveToOppositeGroup",
      title: "Move to Opposite Group",
      category: "Window",
      when: "editorSplit",
      run: () => {
        const t = activePaneTab();
        if (t) ctrl.moveToOpposite(t.paneId, t.tabId);
      },
    },
    {
      id: "editor.unsplit",
      title: "Unsplit",
      category: "Window",
      when: "editorSplit",
      run: () => ctrl.unsplit(useTabs.getState().activePane),
    },
    {
      id: "editor.copyPath",
      title: "Copy Path",
      category: "Edit",
      icon: "copy",
      when: "textEditorActive",
      // ⇧⌘C / Ctrl+Shift+C stays with the terminal (copy) and other tool windows.
      keyWhen: "editorFocus || !toolWindowFocus",
      run: () => {
        const p = ctrl.activePath();
        if (p) void navigator.clipboard?.writeText(p);
      },
    },
    {
      id: "file.save",
      title: "Save All",
      category: "File",
      keywords: ["save"],
      run: () => ctrl.saveAll(),
    },
  ]);
}
