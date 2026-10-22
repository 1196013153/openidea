/**
 * The 3px change lane next to the line numbers (`gutterLaneMarkers`) and the
 * right-hand overview lane over the scrollbar (`scrollbarMarks`).
 */
import { type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { gutterLaneMarkers, scrollbarMarks, type ScrollbarMark } from "@/editor/api";

export const changeLane: Extension = gutter({
  class: "cm-openidea-lane",
  markers: (view) => view.state.facet(gutterLaneMarkers),
});

const MAX_RENDERED = 4000;

class OverviewLane {
  dom: HTMLElement;
  private scheduled = false;
  private lastKey = "";

  constructor(private view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-openidea-overview";
    this.dom.setAttribute("aria-hidden", "true");
    this.dom.addEventListener("mousedown", this.onMouseDown);
    view.dom.appendChild(this.dom);
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (
      u.docChanged ||
      u.geometryChanged ||
      u.heightChanged ||
      u.selectionSet ||
      u.startState.facet(scrollbarMarks) !== u.state.facet(scrollbarMarks)
    )
      this.schedule();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        this.scheduled = false;
        const laneHeight = view.scrollDOM.clientHeight;
        const len = view.state.doc.length;
        // The document itself, without the scroll-past-end padding that follows the editor height.
        const contentHeight = Math.max(view.lineBlockAt(len).bottom, 1);
        // A long document maps onto the lane proportionally: positions in % of the lane
        // stay valid while the window resizes, so a live resize rewrites nothing.
        const fit = contentHeight <= laneHeight;
        const scale = fit ? 1 : laneHeight / contentHeight;
        const unit = fit ? "px" : "%";
        const pos = (y: number) => (fit ? Math.floor(y) : +((y / contentHeight) * 100).toFixed(3));
        const marks = view.state.facet(scrollbarMarks);
        const rows = new Map<string, { top: number; height: number; mark: ScrollbarMark }>();
        for (const m of marks) {
          if (rows.size > MAX_RENDERED) break;
          const from = Math.min(Math.max(0, m.from), len);
          const to = Math.min(Math.max(from, m.to ?? from), len);
          const a = view.lineBlockAt(from);
          const b = to === from ? a : view.lineBlockAt(to);
          // Marks landing on the same lane pixel collapse into one.
          const px = Math.floor(a.top * scale);
          const top = pos(a.top);
          const height = fit ? Math.round(b.bottom - a.top) : +(((b.bottom - a.top) / contentHeight) * 100).toFixed(3);
          const key = `${px}:${m.color}:${m.kind ?? "line"}`;
          const prev = rows.get(key);
          if (!prev || (m.priority ?? 0) > (prev.mark.priority ?? 0) || height > prev.height)
            rows.set(key, { top: prev?.top ?? top, height: Math.max(height, prev?.height ?? 0), mark: m });
        }
        const caret = pos(view.lineBlockAt(view.state.selection.main.head).top);
        return { rows: [...rows.values()].sort((x, y) => (x.mark.priority ?? 0) - (y.mark.priority ?? 0)), caret, unit };
      },
      write: ({ rows, caret, unit }) => {
        const key =
          rows.map((r) => `${r.top},${r.height},${r.mark.color},${r.mark.kind}`).join("|") + `#${caret}${unit}`;
        if (key === this.lastKey) return;
        this.lastKey = key;
        const frag = document.createDocumentFragment();
        for (const r of rows) {
          const el = document.createElement("div");
          el.className = r.mark.kind === "thin" ? "cm-openidea-overviewMark cm-openidea-overviewMark-thin" : "cm-openidea-overviewMark";
          el.style.top = `${r.top}${unit}`;
          el.style.height = `${r.height}${unit}`;
          el.style.background = r.mark.color;
          el.dataset.pos = String(r.mark.from);
          if (r.mark.tooltip) el.title = r.mark.tooltip;
          frag.appendChild(el);
        }
        const c = document.createElement("div");
        c.className = "cm-openidea-overviewCaret";
        c.style.top = `${caret}${unit}`;
        frag.appendChild(c);
        this.dom.replaceChildren(frag);
      },
    });
  }

  private onMouseDown = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".cm-openidea-overviewMark");
    if (!el?.dataset.pos) return;
    e.preventDefault();
    const pos = Math.min(Number(el.dataset.pos), this.view.state.doc.length);
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
      userEvent: "select.overview",
    });
    this.view.focus();
  };

  destroy() {
    this.dom.removeEventListener("mousedown", this.onMouseDown);
    this.dom.remove();
  }
}

export const overviewLane: Extension = ViewPlugin.fromClass(OverviewLane);
