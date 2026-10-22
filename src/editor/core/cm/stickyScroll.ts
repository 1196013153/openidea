/**
 * Sticky scroll: the header lines of the scopes enclosing the first visible
 * line stay pinned at the top (IDEA 2023+ / VS Code). Scopes come from the
 * backend folding ranges, or from the syntax tree when there are none.
 * Clicking a sticky line scrolls to it.
 */
import { Compartment, Facet, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { foldNodeProp, syntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { backendFolds } from "./folding";
import { openideaHighlightStyle } from "./highlight";

/** Maximum number of sticky lines (Settings › Editor › Code Editing). */
export const stickyMaxLines = Facet.define<number, number>({
  combine: (v) => (v.length ? Math.max(1, Math.min(20, v[0]!)) : 5),
});

/** 1-based header line numbers of scopes that contain `lineNo` and start above it. */
export function enclosingHeaders(state: EditorState, lineNo: number): number[] {
  const doc = state.doc;
  if (lineNo < 1 || lineNo > doc.lines) return [];
  const linePos = doc.line(lineNo).from;
  const headers = new Set<number>();
  const folds = state.field(backendFolds, false);
  if (folds?.length) {
    for (const f of folds) {
      if (f.from >= linePos) break;
      if (f.kind !== "region") continue;
      if (f.to >= linePos) headers.add(doc.lineAt(f.from).number);
    }
  } else {
    const tree = syntaxTree(state);
    for (
      let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(linePos, 1);
      node;
      node = node.parent
    ) {
      if (!node.type.prop(foldNodeProp) && !/Body|Block|ClassBody|Object|Array/.test(node.type.name)) continue;
      const start = doc.lineAt(node.from).number;
      const end = doc.lineAt(node.to).number;
      if (start < lineNo && end > lineNo) headers.add(start);
    }
  }
  return [...headers]
    .filter((n) => n < lineNo)
    .sort((a, b) => a - b)
    .slice(-state.facet(stickyMaxLines));
}

function renderLineContent(state: EditorState, lineNo: number, target: HTMLElement) {
  const line = state.doc.line(lineNo);
  const text = line.text.length > 400 ? line.text.slice(0, 400) : line.text;
  const end = line.from + text.length;
  const tree = syntaxTree(state);
  let pos = line.from;
  const push = (to: number, cls: string) => {
    if (to <= pos) return;
    const s = state.doc.sliceString(pos, to);
    if (cls) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = s;
      target.appendChild(span);
    } else target.appendChild(document.createTextNode(s));
    pos = to;
  };
  if (tree.length >= end) {
    highlightTree(
      tree,
      openideaHighlightStyle,
      (from, to, cls) => {
        push(Math.max(from, pos), "");
        push(Math.min(to, end), cls);
      },
      line.from,
      end,
    );
  }
  push(end, "");
}

class StickyScroll {
  dom: HTMLElement;
  private lines: number[] = [];
  /** Text and syntax tree the rows were rendered from (re-render when either changes). */
  private renderedFrom: { texts: string[]; tree: unknown } | null = null;
  private gutterWidth = 0;
  private numberLeft = 0;
  private scheduled = false;

  constructor(private view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-openidea-sticky";
    this.dom.style.display = "none";
    this.dom.setAttribute("aria-hidden", "true");
    this.dom.addEventListener("mousedown", this.onMouseDown);
    view.dom.appendChild(this.dom);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (
      u.docChanged ||
      u.viewportChanged ||
      u.geometryChanged ||
      syntaxTree(u.startState) !== syntaxTree(u.state) ||
      u.startState.field(backendFolds, false) !== u.state.field(backendFolds, false)
    )
      this.schedule();
  }

  private onScroll = () => this.schedule();

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        this.scheduled = false;
        const scroller = view.scrollDOM;
        const scrollTop = scroller.scrollTop;
        const docOffset = view.documentTop - scroller.getBoundingClientRect().top + scrollTop;
        const lh = view.defaultLineHeight;
        const gutters = view.dom.querySelector<HTMLElement>(".cm-gutters");
        const numbers = view.dom.querySelector<HTMLElement>(".cm-lineNumbers");
        const gutterWidth = gutters?.offsetWidth ?? 0;
        const numberWidth = numbers?.offsetWidth ?? 0;
        // Gutters left of the line numbers (e.g. VCS annotations) shift the number column.
        const numberLeft =
          gutters && numbers
            ? Math.max(0, numbers.getBoundingClientRect().left - gutters.getBoundingClientRect().left)
            : 0;
        if (scrollTop - docOffset <= 0)
          return { lines: [] as number[], gutterWidth, numberWidth, numberLeft, scrollLeft: 0 };
        // n sticky rows cover the first n visible lines; they show the n outermost
        // headers of the first line below them, as long as it has that many.
        const lineBelow = (n: number) => {
          const block = view.lineBlockAtHeight(Math.min(scrollTop - docOffset + n * lh + 1, view.contentHeight - 1));
          return view.state.doc.lineAt(block.from).number;
        };
        let headers: number[] = [];
        for (let n = 1; n <= view.state.facet(stickyMaxLines); n++) {
          const enclosing = enclosingHeaders(view.state, lineBelow(n));
          if (enclosing.length < n) break;
          headers = enclosing.slice(0, n);
        }
        return { lines: headers, gutterWidth, numberWidth, numberLeft, scrollLeft: scroller.scrollLeft };
      },
      write: ({ lines, gutterWidth, numberWidth, numberLeft, scrollLeft }) => {
        const state = this.view.state;
        const texts = lines.map((n) => (n <= state.doc.lines ? state.doc.line(n).text : ""));
        const tree = syntaxTree(state);
        const prev = this.renderedFrom;
        const same =
          lines.length === this.lines.length &&
          lines.every((n, i) => n === this.lines[i]) &&
          !!prev &&
          prev.tree === tree &&
          texts.every((t, i) => t === prev.texts[i]);
        if (!lines.length) {
          this.dom.style.display = "none";
          this.lines = [];
          this.renderedFrom = null;
          return;
        }
        this.dom.style.display = "";
        if (!same || gutterWidth !== this.gutterWidth || numberLeft !== this.numberLeft) {
          this.lines = lines;
          this.renderedFrom = { texts, tree };
          this.gutterWidth = gutterWidth;
          this.numberLeft = numberLeft;
          const frag = document.createDocumentFragment();
          for (const n of lines) {
            const row = document.createElement("div");
            row.className = "cm-openidea-stickyLine";
            row.dataset.line = String(n);
            const num = document.createElement("span");
            num.className = "cm-openidea-stickyNumber";
            num.style.width = `${numberWidth}px`;
            num.style.marginLeft = `${numberLeft}px`;
            num.style.marginRight = `${Math.max(0, gutterWidth - numberLeft - numberWidth)}px`;
            num.textContent = String(n);
            const text = document.createElement("span");
            text.className = "cm-openidea-stickyText";
            const inner = document.createElement("span");
            inner.className = "cm-openidea-stickyInner";
            inner.style.display = "inline-block";
            inner.style.paddingLeft = "6px";
            renderLineContent(this.view.state, n, inner);
            text.appendChild(inner);
            row.append(num, text);
            frag.appendChild(row);
          }
          this.dom.replaceChildren(frag);
        }
        for (const inner of this.dom.querySelectorAll<HTMLElement>(".cm-openidea-stickyInner"))
          inner.style.transform = scrollLeft ? `translateX(${-scrollLeft}px)` : "";
      },
    });
  }

  private onMouseDown = (e: MouseEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cm-openidea-stickyLine");
    if (!row?.dataset.line) return;
    e.preventDefault();
    const line = this.view.state.doc.line(Math.min(Number(row.dataset.line), this.view.state.doc.lines));
    const indent = /^\s*/.exec(line.text)![0].length;
    this.view.dispatch({
      selection: { anchor: line.from + indent },
      effects: EditorView.scrollIntoView(line.from, { y: "start" }),
      userEvent: "select.sticky",
    });
    this.view.focus();
  };

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.dom.remove();
  }
}

export const stickyScrollCompartment = new Compartment();
export const stickyScroll: Extension = ViewPlugin.fromClass(StickyScroll);
