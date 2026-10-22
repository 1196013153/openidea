/**
 * IDEA-style Find / Replace bar at the top of the editor (⌘F / ⌘R): search
 * field with Match Case / Words / Regex toggles (⌥C / ⌥W / ⌥X), In Selection
 * (on by default when opened over a multi-line selection), n/N counter,
 * ↑/↓ (⇧↵ / ↵), Replace / Replace All, Esc closes.
 */
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { create } from "zustand";
import clsx from "clsx";
import type { EditorView } from "@codemirror/view";
import { Button, IconButton, SearchField } from "@/ui";
import { editorController, useFindBars, useTabs } from "../controller";
import {
  countMatches,
  findNext,
  findPrevious,
  findScope,
  regexValid,
  replaceAll,
  replaceNext,
  setFindMarks,
  setFindOpen,
  setFindScope,
  setQuery,
  type FindOptions,
  type FindScope,
} from "../cm/find";
import styles from "./EditorArea.module.css";
import { hasPrimaryModifier } from "@/platform/keymap";

/** The query is shared by all panes and survives closing the bar, like IDEA. */
export const useFindOptions = create<FindOptions>(() => ({
  search: "",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  replace: "",
}));
const useFindCounts = create<Record<string, { total: number; current: number; capped: boolean } | null>>(() => ({}));
/** Whether the bar of a pane is limited to a selection ("In Selection"). */
const useFindScoped = create<Record<string, boolean>>(() => ({}));
/** The selection the bar was opened over, for toggling "In Selection" on later. */
const openSelections = new Map<string, FindScope>();

function activeView(paneId: string): EditorView | null {
  const pane = useTabs.getState().panes[paneId];
  if (!pane?.active) return null;
  return editorController().slotFor(pane.active)?.view ?? null;
}

export function closeFindBar(paneId: string) {
  useFindBars.setState({ [paneId]: undefined });
}

/** Opens (or refocuses) the bar; a single-line selection becomes the query. */
export function openFindBar(paneId: string, replace: boolean) {
  const view = activeView(paneId);
  const sel = view?.state.selection.main;
  if (view && sel && !sel.empty) {
    const text = view.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + 500));
    openSelections.set(paneId, { from: sel.from, to: sel.to });
    if (text.includes("\n") || sel.to - sel.from >= 500) {
      // A multi-line selection becomes the search scope, like IDEA.
      view.dispatch({ effects: setFindScope.of({ from: sel.from, to: sel.to }) });
    } else {
      view.dispatch({ effects: setFindScope.of(null) });
      useFindOptions.setState((o) => ({ search: o.regexp ? text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : text }));
    }
  }
  useFindBars.setState((s) => ({ [paneId]: { replace, seq: (s[paneId]?.seq ?? 0) + 1 } }));
}

/** ⌘G / ⇧⌘G: next / previous occurrence of the last search, with or without the bar. */
export function findAgain(paneId: string, forward: boolean) {
  const view = activeView(paneId);
  const opts = useFindOptions.getState();
  if (!view) return;
  if (!opts.search || (opts.regexp && !regexValid(opts.search))) {
    openFindBar(paneId, false);
    return;
  }
  setQuery(view, opts);
  if (forward) findNext(view);
  else findPrevious(view);
  if (useFindBars.getState()[paneId]) recount(paneId);
}

/** Toggles "In Selection": limit to the selection the bar was opened over (or the current one). */
function toggleScope(paneId: string) {
  const view = activeView(paneId);
  if (!view) return;
  if (view.state.field(findScope, false)) {
    view.dispatch({ effects: setFindScope.of(null) });
  } else {
    const main = view.state.selection.main;
    const len = view.state.doc.length;
    const saved = openSelections.get(paneId);
    const range = saved && saved.to <= len && saved.to - saved.from > main.to - main.from ? saved : main;
    if (range.to <= range.from) return;
    view.dispatch({ effects: setFindScope.of({ from: range.from, to: range.to }) });
  }
  recount(paneId);
}

function recount(paneId: string) {
  const view = activeView(paneId);
  if (!view) return;
  const opts = useFindOptions.getState();
  const r = countMatches(view.state);
  useFindCounts.setState({ [paneId]: opts.search ? r : null });
  useFindScoped.setState({ [paneId]: !!view.state.field(findScope, false) });
  view.dispatch({ effects: setFindMarks.of(opts.search ? r.starts : []) });
}

export function FindBar({ paneId }: { paneId: string }) {
  const bar = useFindBars((s) => s[paneId]);
  if (!bar) return null;
  return <FindBarInner paneId={paneId} replace={bar.replace} seq={bar.seq} />;
}

function FindBarInner({ paneId, replace, seq }: { paneId: string; replace: boolean; seq: number }) {
  const activeTab = useTabs((s) => s.panes[paneId]?.active ?? null);
  const opts = useFindOptions();
  const count = useFindCounts((s) => s[paneId] ?? null);
  const scoped = useFindScoped((s) => !!s[paneId]);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const setOpts = (patch: Partial<FindOptions>) => useFindOptions.setState(patch);

  // Opening (or ⌘F again): focus + select the field.
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [seq]);

  // Push the query into the editor; incremental search selects the nearest match.
  useEffect(() => {
    const view = activeView(paneId);
    if (!view) return;
    const valid = !opts.regexp || regexValid(opts.search);
    setQuery(view, valid ? opts : { ...opts, search: "" });
    view.dispatch({ effects: setFindOpen.of(true) });
    if (valid && opts.search) {
      const from = view.state.selection.main.from;
      view.dispatch({ selection: { anchor: from } });
      findNext(view);
    }
    recount(paneId);
  }, [opts, paneId, activeTab]);

  // Keep the counter current while the document / selection changes.
  useEffect(() => {
    const slot = activeTab ? editorController().slotFor(activeTab) : null;
    if (!slot) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = (u: { docChanged: boolean; selectionSet: boolean }) => {
      if (!u.docChanged && !u.selectionSet) return;
      clearTimeout(timer);
      timer = setTimeout(() => recount(paneId), u.docChanged ? 150 : 0);
    };
    slot.listeners.add(listener);
    return () => {
      clearTimeout(timer);
      slot.listeners.delete(listener);
    };
  }, [activeTab, paneId]);

  // Closing clears highlights, marks and the selection scope (not React's dev-mode remount).
  useEffect(
    () => () => {
      if (!useFindBars.getState()[paneId]) activeView(paneId)?.dispatch({ effects: [setFindOpen.of(false)] });
    },
    [paneId],
  );

  const close = () => {
    closeFindBar(paneId);
    activeView(paneId)?.focus();
  };
  const run = (cmd: (v: EditorView) => boolean) => {
    const view = activeView(paneId);
    if (view) cmd(view);
    recount(paneId);
  };
  const toggle = (key: "caseSensitive" | "wholeWord" | "regexp") =>
    useFindOptions.setState((o) => ({ [key]: !o[key] }));

  const onKeyDown = (e: KeyboardEvent, field: "find" | "replace") => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "F3") {
      e.preventDefault();
      const back = e.key === "ArrowUp" || (e.shiftKey && e.key !== "ArrowDown");
      if (field === "replace" && e.key === "Enter" && !e.shiftKey) {
        if (hasPrimaryModifier(e)) run(replaceAll);
        else run(replaceNext);
      } else run(back ? findPrevious : findNext);
    } else if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const map: Record<string, "caseSensitive" | "wholeWord" | "regexp"> = { KeyC: "caseSensitive", KeyW: "wholeWord", KeyX: "regexp" };
      const k = map[e.code];
      if (k) {
        e.preventDefault();
        toggle(k);
      } else if (e.code === "KeyE") {
        e.preventDefault();
        toggleScope(paneId);
      }
    } else if (e.key === "Tab" && !e.shiftKey && field === "find" && replace) {
      e.preventDefault();
      replaceRef.current?.focus();
    }
  };

  const invalid = opts.regexp && !!opts.search && !regexValid(opts.search);
  const none = !!opts.search && !invalid && count?.total === 0;
  const counter = invalid
    ? "Bad regex"
    : !opts.search
      ? ""
      : !count || count.total === 0
        ? "0 results"
        : `${count.current || "?"}/${count.total}${count.capped ? "+" : ""}`;

  return (
    <div className={styles.find} role="search" aria-label={replace ? "Replace in file" : "Find in file"}>
      <SearchField
        ref={inputRef}
        className={styles.findField}
        value={opts.search}
        onChange={(search) => setOpts({ search })}
        placeholder="Find"
        aria-label="Find"
        invalid={invalid || none}
        onKeyDown={(e) => onKeyDown(e, "find")}
        toggles={[
          { id: "case", icon: "case", title: "Match Case", shortcut: "⌥C", pressed: opts.caseSensitive, onToggle: () => toggle("caseSensitive") },
          { id: "word", icon: "word", title: "Words", shortcut: "⌥W", pressed: opts.wholeWord, onToggle: () => toggle("wholeWord") },
          { id: "regex", icon: "regex", title: "Regex", shortcut: "⌥X", pressed: opts.regexp, onToggle: () => toggle("regexp") },
          { id: "scope", icon: "filter", title: "In Selection", shortcut: "⌥E", pressed: scoped, onToggle: () => toggleScope(paneId) },
        ]}
      />
      <div className={styles.findButtons}>
        <span className={clsx(styles.findCount, (none || invalid) && styles.findCountNone)} aria-live="polite">
          {counter}
        </span>
        <IconButton icon="arrow-up" title="Previous Occurrence" shortcut="⇧↵" size="small" onClick={() => run(findPrevious)} />
        <IconButton icon="arrow-down" title="Next Occurrence" shortcut="↵" size="small" onClick={() => run(findNext)} />
        <IconButton
          icon="replace"
          title={replace ? "Hide Replace" : "Show Replace"}
          size="small"
          pressed={replace}
          onClick={() => openFindBar(paneId, !replace)}
        />
      </div>
      <IconButton icon="close" title="Close" shortcut="⎋" size="small" className={styles.findClose} onClick={close} />
      {replace && (
        <>
          <SearchField
            ref={replaceRef}
            className={styles.findField}
            value={opts.replace}
            onChange={(value) => setOpts({ replace: value })}
            placeholder="Replace"
            aria-label="Replace"
            leadingIcon="replace"
            onKeyDown={(e) => onKeyDown(e, "replace")}
          />
          <div className={styles.replaceButtons}>
            <Button size="small" onClick={() => run(replaceNext)} disabled={!opts.search || invalid}>
              Replace
            </Button>
            <Button size="small" onClick={() => run(replaceAll)} disabled={!opts.search || invalid}>
              Replace All
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
