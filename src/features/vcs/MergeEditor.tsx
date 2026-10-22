/** Three-pane merge conflict editor: Yours | Result | Theirs. */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import { call, commands } from "@/platform/ipc";
import { Button, IconButton, Spinner } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { languageFor, viewerBase } from "./cm";
import { confirmDialog } from "./dialogs";
import { parseConflicts, resolutionText, resolveAll, type ConflictBlock, type Resolution } from "./conflicts";
import { baseName } from "./model";
import { errorMessage, readWorkingText, runOp, writeFileText } from "./ops";
import { refreshNow } from "./store";
import styles from "./MergeEditor.module.css";

import type { MergeData } from "./mergeKind";
export { MERGE_KIND, mergeInput, type MergeData } from "./mergeKind";

function resolveBlock(view: EditorView, block: ConflictBlock, how: Resolution) {
  view.dispatch({
    changes: { from: block.from, to: block.to, insert: resolutionText(block, how) },
    userEvent: "input.resolve",
  });
}

class ActionsWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly block: ConflictBlock,
  ) {
    super();
  }
  eq(o: ActionsWidget) {
    return o.index === this.index && o.block.from === this.block.from && o.block.to === this.block.to;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-conflict-actions";
    const add = (label: string, how: Resolution) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      // Keep the caret / focus in the editor; resolve on click (mouse or keyboard).
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = (e) => {
        e.preventDefault();
        const live = parseConflicts(view.state.doc.toString())[this.index];
        if (live) resolveBlock(view, live, how);
      };
      el.appendChild(b);
    };
    const title = document.createElement("span");
    title.textContent = `Conflict ${this.index + 1}`;
    el.appendChild(title);
    add("Accept Yours", "ours");
    add("Accept Theirs", "theirs");
    add("Accept Both", "both");
    if (this.block.base !== null) add("Use Base", "base");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const oursLine = Decoration.line({ class: "cm-conflict-ours" });
const theirsLine = Decoration.line({ class: "cm-conflict-theirs" });
const markerLine = Decoration.line({ class: "cm-conflict-marker" });

function decorate(state: EditorState): { blocks: ConflictBlock[]; deco: DecorationSet } {
  const blocks = parseConflicts(state.doc.toString());
  const b = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  blocks.forEach((blk, i) => {
    b.add(blk.from, blk.from, Decoration.widget({ widget: new ActionsWidget(i, blk), block: true, side: -1 }));
    const endLine = doc.lineAt(Math.max(blk.from, blk.to - 1)).number;
    for (let n = doc.lineAt(blk.from).number; n <= endLine; n++) {
      const line = doc.line(n);
      const deco =
        line.from >= blk.oursFrom && line.from < blk.oursTo
          ? oursLine
          : line.from >= blk.theirsFrom && line.from < blk.theirsTo
            ? theirsLine
            : markerLine;
      b.add(line.from, line.from, deco);
    }
  });
  return { blocks, deco: b.finish() };
}

const conflictField = StateField.define<{ blocks: ConflictBlock[]; deco: DecorationSet }>({
  create: decorate,
  update: (v, tr) => (tr.docChanged ? decorate(tr.state) : v),
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const resultTheme = EditorView.baseTheme({
  ".cm-conflict-ours": { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)" },
  ".cm-conflict-theirs": { backgroundColor: "color-mix(in srgb, var(--vcs-added) 12%, transparent)" },
  ".cm-conflict-marker": { backgroundColor: "color-mix(in srgb, var(--vcs-conflict) 14%, transparent)", color: "var(--fg-subtle)" },
  ".cm-conflict-actions": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 8px",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    color: "var(--vcs-conflict)",
    background: "var(--bg-elev)",
    borderTop: "1px solid var(--border)",
  },
  ".cm-conflict-actions button": {
    padding: "0 6px",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-small)",
    color: "var(--fg-secondary)",
    background: "var(--bg-control)",
    font: "inherit",
    lineHeight: "18px",
  },
  ".cm-conflict-actions button:hover": { color: "var(--fg-strong)", background: "var(--bg-control-hover)" },
});

export function MergeEditor({ input }: { input: EditorInput }) {
  const { path } = input.data as MergeData;
  const [state, setState] = useState<{
    ours: string;
    theirs: string;
    base: string | null;
    working: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<Extension | null>(null);
  const [left, setLeft] = useState(0);
  const [resolved, setResolved] = useState(false);
  const oursRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const resultView = useRef<EditorView | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, working] = await Promise.all([call(commands.vcsConflictVersions(path)), readWorkingText(path)]);
      setState({ ours: v.ours ?? "", theirs: v.theirs ?? "", base: v.base, working: working ?? "" });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [path]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useEffect(() => {
    let alive = true;
    void languageFor(path).then((l) => alive && setLang(() => l ?? []));
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    if (!state || lang === null || !oursRef.current || !resultRef.current || !theirsRef.current) return;
    const side = () => [
      viewerBase({ readOnly: true }),
      lang,
      state.base !== null ? unifiedMergeView({ original: state.base, mergeControls: false, gutter: true }) : [],
    ];
    const ours = new EditorView({ doc: state.ours, parent: oursRef.current, extensions: side() });
    const theirs = new EditorView({ doc: state.theirs, parent: theirsRef.current, extensions: side() });
    const result = new EditorView({
      doc: state.working,
      parent: resultRef.current,
      extensions: [
        viewerBase({ readOnly: false }),
        history(),
        keymap.of(historyKeymap),
        lang,
        conflictField,
        resultTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setLeft(u.state.field(conflictField).blocks.length);
        }),
      ],
    });
    resultView.current = result;
    setLeft(result.state.field(conflictField).blocks.length);
    return () => {
      ours.destroy();
      theirs.destroy();
      result.destroy();
      resultView.current = null;
    };
  }, [state, lang]);

  const goto = (dir: 1 | -1) => {
    const v = resultView.current;
    if (!v) return;
    const blocks = v.state.field(conflictField).blocks;
    if (!blocks.length) return;
    const head = v.state.selection.main.head;
    const target =
      dir === 1
        ? (blocks.find((b) => b.from > head) ?? blocks[0]!)
        : ([...blocks].reverse().find((b) => b.to < head) ?? blocks[blocks.length - 1]!);
    v.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
    v.focus();
  };

  const acceptAll = (how: Resolution) => {
    const v = resultView.current;
    if (!v) return;
    const text = v.state.doc.toString();
    v.dispatch({ changes: { from: 0, to: text.length, insert: resolveAll(text, how) }, userEvent: "input.resolve" });
  };

  const apply = async () => {
    const v = resultView.current;
    if (!v) return;
    const remaining = v.state.field(conflictField).blocks.length;
    if (
      remaining > 0 &&
      !(await confirmDialog({
        title: "Unresolved Conflicts",
        message: `${remaining} conflict${remaining === 1 ? "" : "s"} still contain conflict markers. Save and mark the file as resolved anyway?`,
        okLabel: "Mark Resolved",
      }))
    )
      return;
    const text = v.state.doc.toString();
    const ok = await runOp(
      `Resolve ${baseName(path)}`,
      async () => {
        await writeFileText(path, text, { save: true });
        await call(commands.vcsStage([path]));
      },
      { success: `${baseName(path)}: conflicts resolved` },
    );
    if (ok !== undefined) {
      setResolved(true);
      await refreshNow();
    }
  };

  if (error)
    return (
      <div className={styles.message}>
        {error}
        <Button onClick={() => void load()}>Retry</Button>
      </div>
    );
  if (resolved)
    return (
      <div className={styles.message}>
        {baseName(path)} has been resolved and staged.
        <Button onClick={() => void editorService().openFile(path, { focus: true })}>Open File</Button>
      </div>
    );

  return (
    <div className={styles.root}>
      <div className={styles.toolbar} role="toolbar" aria-label="Merge">
        <IconButton icon="arrow-up" title="Previous Conflict" size="small" onClick={() => goto(-1)} />
        <IconButton icon="arrow-down" title="Next Conflict" size="small" onClick={() => goto(1)} />
        <span className={styles.sep} />
        <Button size="small" onClick={() => acceptAll("ours")}>
          Accept All Yours
        </Button>
        <Button size="small" onClick={() => acceptAll("theirs")}>
          Accept All Theirs
        </Button>
        <IconButton icon="refresh" title="Reload from Disk" size="small" onClick={() => void load()} />
        <span className={clsx(styles.status, !left && styles.statusDone)}>
          {left ? `${left} conflict${left === 1 ? "" : "s"} left` : "All conflicts resolved"}
        </span>
        <Button size="small" variant="primary" onClick={() => void apply()}>
          Apply
        </Button>
      </div>
      <div className={styles.labels}>
        <span>Yours (current branch)</span>
        <span>Result</span>
        <span>Theirs (incoming)</span>
      </div>
      {!state || lang === null ? (
        <div className={styles.message}>
          <Spinner size={14} />
        </div>
      ) : null}
      <div className={styles.panes} hidden={!state || lang === null}>
        <div ref={oursRef} className={styles.pane} aria-label="Your version" role="region" />
        <div ref={resultRef} className={styles.pane} aria-label="Result" role="region" />
        <div ref={theirsRef} className={styles.pane} aria-label="Their version" role="region" />
      </div>
    </div>
  );
}
