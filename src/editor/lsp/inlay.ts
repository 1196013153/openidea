/**
 * Inlay hints (settings.editor.inlayHints) for the visible range, refreshed
 * after edits / scrolling (debounced) and rendered as subtle inline widgets.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { commands, type InlayHint } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { editorPrefs } from "@/platform/editorSettings";
import { debounce, docOf, isUnavailable, lspRequest } from "./lsp";
import { offsetsToRange, posToOffset } from "./positions";
import { onLspRefresh, serverBackoff } from "./availability";

class InlayWidget extends WidgetType {
  constructor(readonly hint: InlayHint) {
    super();
  }
  eq(other: InlayWidget) {
    const a = this.hint,
      b = other.hint;
    return a.label === b.label && a.kind === b.kind && a.paddingLeft === b.paddingLeft && a.paddingRight === b.paddingRight;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-lsp-inlay cm-lsp-inlay-${this.hint.kind}`;
    if (this.hint.paddingLeft) el.classList.add("cm-lsp-inlay-pl");
    if (this.hint.paddingRight) el.classList.add("cm-lsp-inlay-pr");
    el.textContent = this.hint.label;
    if (this.hint.tooltip) el.title = this.hint.tooltip;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const setInlays = StateEffect.define<DecorationSet>();

const inlayField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setInlays)) return e.value;
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function inlayDecorations(view: EditorView, hints: readonly InlayHint[]): DecorationSet {
  const doc = view.state.doc;
  return Decoration.set(
    hints.map((h) =>
      Decoration.widget({ widget: new InlayWidget(h), side: h.kind === "parameter" ? 1 : -1 }).range(posToOffset(doc, h.position)),
    ),
    true,
  );
}

const enabled = (language: string) =>
  useProject.getState().settings?.editor?.inlayHints !== false && !editorPrefs().inlay.disabledLanguages.includes(language);

/** Inlay Hints settings: per kind (types / parameters / other). */
function shownKind(kind: InlayHint["kind"]): boolean {
  const p = editorPrefs().inlay;
  return kind === "type" ? p.types : kind === "parameter" ? p.parameters : p.other;
}

const inlayPlugin = ViewPlugin.fromClass(
  class {
    private refresh = debounce(() => void this.run(), 400);
    private unsubscribe: () => void;
    private offReady: () => void;
    constructor(private view: EditorView) {
      this.refresh();
      this.unsubscribe = useProject.subscribe((s, prev) => {
        if (s.settings?.editor?.inlayHints !== prev.settings?.editor?.inlayHints || s.settings?.editor?.inlay !== prev.settings?.editor?.inlay)
          this.refresh();
      });
      this.offReady = onLspRefresh("inlayHints", () => this.refresh());
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.refresh();
    }
    async run() {
      const view = this.view;
      if (!view.dom.isConnected) return;
      const doc = docOf(view);
      if (!doc) return;
      if (!enabled(doc.language) || serverBackoff.active(doc.doc)) {
        if (view.state.field(inlayField).size) view.dispatch({ effects: setInlays.of(Decoration.none) });
        return;
      }
      const state = view.state;
      const { from, to } = view.viewport;
      const first = state.doc.lineAt(from).from;
      const last = state.doc.lineAt(to).to;
      try {
        const hints = await lspRequest(() => commands.lspInlayHints(doc.doc, offsetsToRange(state.doc, first, last)));
        if (view.state.doc !== state.doc) return this.refresh();
        view.dispatch({ effects: setInlays.of(inlayDecorations(view, hints.filter((h) => shownKind(h.kind)))) });
      } catch (e) {
        if (isUnavailable(e)) serverBackoff.mark(doc.doc);
      }
    }
    destroy() {
      this.refresh.cancel();
      this.unsubscribe();
      this.offReady();
    }
  },
);

export function inlayExtension(): Extension {
  return [inlayField, inlayPlugin];
}
