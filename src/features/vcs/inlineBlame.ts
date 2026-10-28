/**
 * Inline blame (IDEA's "Show Git blame for the current line" / GitToolBox): the
 * author, age and subject of the commit that last changed the caret line, faded
 * after its end. Clicking it shows the commit in the Git log.
 *
 * Blame comes from the same `vcs_blame` command as the Annotate gutter
 * (`blame.ts`), cached per file and refetched only when the file is saved or
 * changes on disk, or HEAD moves; never on caret moves. Edits made since the
 * blame are mapped through the composed `ChangeSet`: an edited (or inserted)
 * line shows nothing, like an uncommitted one.
 */
import { ChangeSet, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import type { BlameLine } from "@/bindings";
import type { EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { isUncommitted } from "./blame";
import { statusOf, useVcs } from "./store";

/** Larger documents are not blamed (IDEA's large-file threshold, 2.5 MB). */
export const MAX_INLINE_BLAME_LENGTH = 2_500_000;
const MAX_SUMMARY = 60;
const MAX_CACHED_FILES = 50;

// --- text ---------------------------------------------------------------------------

/** "3 days ago"-style age of a commit time (same texts as the GitHub views). */
export function relativeAge(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  const units: Array<[number, (n: number) => string]> = [
    [60 * 60 * 24 * 365, (n) => (n === 1 ? tx`${n} year ago` : tx`${n} years ago`)],
    [60 * 60 * 24 * 30, (n) => (n === 1 ? tx`${n} month ago` : tx`${n} months ago`)],
    [60 * 60 * 24, (n) => (n === 1 ? tx`${n} day ago` : tx`${n} days ago`)],
    [60 * 60, (n) => (n === 1 ? tx`${n} hour ago` : tx`${n} hours ago`)],
    [60, (n) => (n === 1 ? tx`${n} minute ago` : tx`${n} minutes ago`)],
  ];
  for (const [size, text] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return text(n);
  }
  return tx("just now");
}

/** `Author, 3 days ago · subject` (subject shortened). */
export function inlineBlameText(line: BlameLine, now = Date.now()): string {
  const who = line.timeMs ? `${line.author}, ${relativeAge(line.timeMs, now)}` : line.author;
  const summary = line.summary.trim();
  if (!summary) return who;
  const short = summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary;
  return `${who} · ${short}`;
}

/** Hover text: short hash, author, full time, subject (as the Annotate gutter's). */
export function inlineBlameTooltip(line: BlameLine): string {
  const time = line.timeMs ? new Date(line.timeMs).toLocaleString() : "";
  return `${line.commit.slice(0, 8)}  ${line.author}  ${time}\n${line.summary}`;
}

// --- mapping edits ------------------------------------------------------------------

/** A blame result and the document text it was computed for. */
export interface BlameSnapshot {
  lines: readonly BlameLine[];
  base: Text;
}

/**
 * Whether `changes` (base → current document) touched the current line
 * `[from, to]`. Whole lines inserted or removed right above or below it don't.
 */
export function lineTouched(changes: ChangeSet, base: Text, from: number, to: number): boolean {
  let touched = false;
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (touched || fromB > to || toB < from) return;
    // Ends at the line start: whole lines inserted / deleted above it.
    const above = toB === from && base.lineAt(toA).from === toA && (!inserted.length || endsWithNewline(inserted));
    // Starts at the line end: whole lines inserted / deleted below it.
    const below =
      fromB === to && base.lineAt(fromA).to === fromA && (!inserted.length || inserted.sliceString(0, 1) === "\n");
    if (!above && !below) touched = true;
  });
  return touched;
}

function endsWithNewline(text: Text): boolean {
  return text.sliceString(text.length - 1) === "\n";
}

/**
 * The commit of line `lineNo` (1-based) of `doc`, `doc` being the snapshot's base
 * changed by `changes`; null for edited and uncommitted lines (and a mismatch).
 */
export function blameForLine(snap: BlameSnapshot, changes: ChangeSet, doc: Text, lineNo: number): BlameLine | null {
  if (changes.length !== snap.base.length || changes.newLength !== doc.length || lineNo > doc.lines) return null;
  const line = doc.line(lineNo);
  if (lineTouched(changes, snap.base, line.from, line.to)) return null;
  const oldPos = changes.invertedDesc.mapPos(line.from, 1);
  const old = snap.base.lineAt(oldPos);
  if (old.from !== oldPos || old.text !== line.text) return null;
  const blame = snap.lines[old.number - 1];
  return blame && !isUncommitted(blame) ? blame : null;
}

// --- cache --------------------------------------------------------------------------

type Invalidated = (path: string | null) => void;

/**
 * Blame per file, for the document text it was requested with; a failure (not in a
 * repository…) is remembered as null. `invalidate` drops entries and tells the
 * editors showing them to ask again.
 */
export class BlameCache {
  private readonly entries = new Map<string, { base: Text; result: Promise<BlameSnapshot | null> }>();
  private readonly listeners = new Set<Invalidated>();

  constructor(private readonly fetch: (path: string) => Promise<BlameLine[]>) {}

  get(path: string, doc: Text): Promise<BlameSnapshot | null> {
    const hit = this.entries.get(path);
    if (hit && (hit.base === doc || hit.base.eq(doc))) return hit.result;
    const result = this.fetch(path).then(
      (lines): BlameSnapshot => ({ lines, base: doc }),
      () => null,
    );
    this.entries.delete(path);
    this.entries.set(path, { base: doc, result });
    if (this.entries.size > MAX_CACHED_FILES) this.entries.delete(this.entries.keys().next().value!);
    return result;
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** Drops `path` (all files when omitted) and notifies the subscribers. */
  invalidate(path?: string) {
    if (path === undefined) this.entries.clear();
    else this.entries.delete(path);
    for (const l of this.listeners) l(path ?? null);
  }

  subscribe(listener: Invalidated): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

export const inlineBlameCache = new BlameCache((path) => call(commands.vcsBlame(path)));

/** Invalidates on HEAD moves (commit, checkout, reset…), repository changes and files changed on disk. */
export function installInlineBlame(): () => void {
  const heads = (s: ReturnType<typeof useVcs.getState>) =>
    `${s.available}\n${s.root}\n${s.branch?.headCommit}\n${JSON.stringify(s.heads)}`;
  const offVcs = useVcs.subscribe((s, prev) => {
    if (heads(s) !== heads(prev)) inlineBlameCache.invalidate();
  });
  const offFs = onIdeEvent("fsChanged", (e) => {
    for (const p of [...e.created, ...e.modified, ...e.removed])
      if (inlineBlameCache.has(p)) inlineBlameCache.invalidate(p);
  });
  return () => {
    offVcs();
    offFs();
  };
}

// --- editor -------------------------------------------------------------------------

interface InlineBlameState {
  enabled: boolean;
  snap: BlameSnapshot | null;
  /** Snapshot base → current document. */
  changes: ChangeSet | null;
}

const setSnapshot = StateEffect.define<{ snap: BlameSnapshot | null; changes: ChangeSet }>();
const setEnabled = StateEffect.define<boolean>();

const inlineBlameField = StateField.define<InlineBlameState>({
  create: () => ({ enabled: false, snap: null, changes: null }),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.changes) next = { ...next, changes: value.changes.compose(tr.changes) };
    for (const e of tr.effects) {
      if (e.is(setEnabled)) next = { ...next, enabled: e.value };
      else if (e.is(setSnapshot)) {
        const changes = tr.docChanged ? e.value.changes.compose(tr.changes) : e.value.changes;
        next = { ...next, snap: e.value.snap, changes: e.value.snap ? changes : null };
      }
    }
    return next;
  },
});

class InlineBlameWidget extends WidgetType {
  constructor(
    readonly line: BlameLine,
    readonly text: string,
  ) {
    super();
  }
  eq(o: InlineBlameWidget) {
    return o.line.commit === this.line.commit && o.text === this.text;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vcs-inline-blame";
    el.textContent = this.text;
    el.title = inlineBlameTooltip(this.line);
    const commit = this.line.commit;
    // Keep the caret where it is.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      void executeAction("vcs.showCommit", commit);
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function decorationsFor(state: EditorState): DecorationSet {
  const st = state.field(inlineBlameField, false);
  if (!st?.enabled || !st.snap || !st.changes) return Decoration.none;
  const line = state.doc.lineAt(state.selection.main.head);
  const blame = blameForLine(st.snap, st.changes, state.doc, line.number);
  if (!blame) return Decoration.none;
  const widget = new InlineBlameWidget(blame, inlineBlameText(blame));
  return Decoration.set([Decoration.widget({ widget, side: 1 }).range(line.to)]);
}

/** Fetches blame for the view: at start, after invalidation, when enabled; not on caret moves. */
class InlineBlameFetcher implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stale = true;
  private ticket = 0;
  /** Edits made while a request is in flight (request document → current). */
  private pending: ChangeSet | null = null;
  private destroyed = false;
  private readonly offs: Array<() => void>;

  constructor(
    private readonly view: EditorView,
    private readonly path: string,
    doc: number,
  ) {
    this.offs = [
      onWorkflowSettingsChange(
        (w) => w.vcs.inlineBlame,
        (on) => {
          this.view.dispatch({ effects: setEnabled.of(on) });
          this.invalidate(0);
        },
      ),
      inlineBlameCache.subscribe((p) => {
        if (p === null || p === path) this.invalidate(150);
      }),
      // Saved (or reverted): blame the written file.
      onIdeEvent("docDirty", (e) => {
        if (e.doc === doc && !e.dirty) inlineBlameCache.invalidate(path);
      }),
    ];
    this.schedule(50);
  }

  update(u: ViewUpdate) {
    if (u.docChanged && this.pending) this.pending = this.pending.compose(u.changes);
    // Invalidated while hidden: fetch once it is shown / used again.
    if (this.stale && this.timer === undefined && (u.focusChanged || u.selectionSet || u.geometryChanged))
      this.schedule(0);
  }

  private invalidate(delay: number) {
    this.stale = true;
    this.schedule(delay);
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.fetch();
    }, delay);
  }

  private wanted(): boolean {
    const state = this.view.state;
    if (!state.field(inlineBlameField).enabled || !useVcs.getState().available || !isTauri()) return false;
    if (state.doc.length > MAX_INLINE_BLAME_LENGTH) return false;
    const status = statusOf(this.path)?.unstaged;
    return status !== "untracked" && status !== "ignored";
  }

  private async fetch() {
    if (this.destroyed || !this.stale) return;
    if (!this.wanted()) {
      this.stale = false;
      ++this.ticket;
      this.pending = null;
      if (this.view.state.field(inlineBlameField).snap)
        this.view.dispatch({ effects: setSnapshot.of({ snap: null, changes: ChangeSet.empty(0) }) });
      return;
    }
    // Hidden editor (inactive tab): wait until it is shown.
    if (!this.view.dom.isConnected || !this.view.dom.getClientRects().length) return;
    this.stale = false;
    const ticket = ++this.ticket;
    const doc = this.view.state.doc;
    this.pending = ChangeSet.empty(doc.length);
    const snap = await inlineBlameCache.get(this.path, doc);
    if (this.destroyed || ticket !== this.ticket || !this.pending) return;
    const changes = this.pending;
    this.pending = null;
    this.view.dispatch({ effects: setSnapshot.of({ snap, changes }) });
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.offs.forEach((off) => off());
  }
}

const inlineBlameTheme = EditorView.baseTheme({
  ".cm-vcs-inline-blame": {
    marginLeft: "3em",
    color: "color-mix(in srgb, var(--fg-secondary) 55%, var(--fg-gutter))",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    fontStyle: "normal",
    fontWeight: "normal",
    whiteSpace: "pre",
    cursor: "pointer",
    WebkitUserSelect: "none",
    userSelect: "none",
  },
  ".cm-vcs-inline-blame:hover": { color: "var(--fg-strong)", textDecoration: "underline" },
});

/** Extensions for one text editor (registered with the change markers). */
export function inlineBlame(ctx: EditorDocContext): Extension {
  // Library classes are not in the working tree.
  if (ctx.virtual) return [];
  const path = ctx.path;
  return [
    inlineBlameField.init(() => ({ enabled: workflowSettings().vcs.inlineBlame, snap: null, changes: null })),
    EditorView.decorations.compute([inlineBlameField, "doc", "selection"], decorationsFor),
    ViewPlugin.define((view) => new InlineBlameFetcher(view, path, ctx.doc)),
    inlineBlameTheme,
  ];
}
