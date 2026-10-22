/**
 * Bookmark gutter: a narrow CodeMirror gutter with a marker per bookmarked
 * line. Markers map through edits, and moved lines are written back to the
 * store so bookmarks follow the code.
 */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { linesOf, setFileLines, updateBookmarks, useBookmarks } from "./store";

const SVG_NS = "http://www.w3.org/2000/svg";

class BookmarkMarker extends GutterMarker {
  toDOM() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "11");
    svg.setAttribute("height", "11");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("cm-openidea-bookmark");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M7 4h10v16l-5-4-5 4z");
    svg.appendChild(path);
    return svg;
  }
}

class SpacerMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("span");
    el.style.display = "inline-block";
    el.style.width = "11px";
    return el;
  }
}

const marker = new BookmarkMarker();
const spacer = new SpacerMarker();

const setLines = StateEffect.define<number[]>();

function build(doc: EditorView["state"]["doc"], lines: readonly number[]): RangeSet<GutterMarker> {
  const ranges = [...new Set(lines)]
    .filter((l) => l >= 0 && l < doc.lines)
    .sort((a, b) => a - b)
    .map((l) => marker.range(doc.line(l + 1).from));
  return RangeSet.of(ranges);
}

function linesIn(view: EditorView, set: RangeSet<GutterMarker>): number[] {
  const out: number[] = [];
  const iter = set.iter();
  while (iter.value) {
    out.push(view.state.doc.lineAt(iter.from).number - 1);
    iter.next();
  }
  return out;
}

const sameLines = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function bookmarkGutter(path: string): Extension {
  const field = StateField.define<RangeSet<GutterMarker>>({
    create: (state) => build(state.doc, linesOf(useBookmarks.getState().items, path)),
    update(value, tr) {
      let next = tr.docChanged ? value.map(tr.changes) : value;
      for (const e of tr.effects) if (e.is(setLines)) next = build(tr.state.doc, e.value);
      return next;
    },
  });

  const sync = ViewPlugin.fromClass(
    class {
      private unsub: () => void;
      private pending = false;
      constructor(private readonly view: EditorView) {
        this.unsub = useBookmarks.subscribe((s, prev) => {
          if (s.items === prev.items) return;
          const want = linesOf(s.items, path);
          if (!sameLines(want, linesIn(this.view, this.view.state.field(field)))) {
            this.view.dispatch({ effects: setLines.of(want) });
          }
        });
        // Bookmarks may have changed while this editor was being created.
        const want = linesOf(useBookmarks.getState().items, path);
        if (!sameLines(want, linesIn(view, view.state.field(field)))) {
          queueMicrotask(() => view.dispatch({ effects: setLines.of(want) }));
        }
      }
      update(u: ViewUpdate) {
        if (!u.docChanged || this.pending) return;
        this.pending = true;
        // Write back after the update cycle (dispatching inside update is not allowed).
        queueMicrotask(() => {
          this.pending = false;
          const view = this.view;
          if (!view.dom.isConnected) return;
          const lines = linesIn(view, view.state.field(field));
          const stored = linesOf(useBookmarks.getState().items, path);
          if (sameLines(lines, stored)) return;
          updateBookmarks((list) =>
            setFileLines(
              list,
              path,
              lines.map((l) => ({ line: l, text: view.state.doc.line(l + 1).text })),
            ),
          );
        });
      }
      destroy() {
        this.unsub();
      }
    },
  );

  return [
    field,
    sync,
    gutter({
      class: "cm-openidea-bookmarks",
      markers: (v) => v.state.field(field),
      initialSpacer: () => spacer,
    }),
    theme,
  ];
}

const theme = EditorView.baseTheme({
  ".cm-openidea-bookmarks .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 2px",
  },
  ".cm-openidea-bookmark": {
    fill: "none",
    stroke: "var(--accent)",
    strokeWidth: "2",
    strokeLinejoin: "round",
  },
});
