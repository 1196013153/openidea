/**
 * Parameter info (⌘P, and automatically after `(` / `,`): a tooltip above the
 * caret listing the signatures with the active parameter in bold. While open
 * it follows the caret and closes when the server reports no signature.
 */
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { commands, type SignatureHelp } from "@/platform/ipc";
import { docOf, lspRequest, reportLspError, debounce } from "./lsp";
import { offsetToPos } from "./positions";
import { showHint } from "./hint";
import { renderMarkup, isEmptyMarkup } from "./markdown";
import { editorPrefs } from "@/platform/editorSettings";

interface SigState {
  pos: number;
  help: SignatureHelp;
}

const setSignature = StateEffect.define<SigState | null>();

const signatureField = StateField.define<SigState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSignature)) return e.value;
    if (value && tr.docChanged) return { ...value, pos: tr.changes.mapPos(value.pos) };
    return value;
  },
  provide: (f) => showTooltip.from(f, (s) => (s ? signatureTooltip(s) : null)),
});

/** Splits a signature label around the active parameter's UTF-16 range. */
export function splitSignature(label: string, params: ReadonlyArray<[number, number]>, active: number) {
  const range = params[active];
  if (!range) return { before: label, param: "", after: "" };
  const [s, e] = range;
  return { before: label.slice(0, s), param: label.slice(s, e), after: label.slice(e) };
}

const MAX_ROWS = 12;

/** Whether an overload can take an argument at `index` (varargs take any number). */
export function acceptsParameter(sig: { label: string; parameters: ReadonlyArray<[number, number]> }, index: number) {
  if (index < sig.parameters.length) return true;
  const last = sig.parameters[sig.parameters.length - 1];
  return !!last && /\.\.\.|^\s*\*/.test(sig.label.slice(last[0], last[1]));
}

function signatureTooltip(s: SigState): Tooltip {
  return {
    pos: s.pos,
    above: true,
    strictSide: false,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-lsp-signature";
      const { signatures, activeSignature, activeParameter } = s.help;
      const start = Math.max(0, Math.min(activeSignature - 6, signatures.length - MAX_ROWS));
      signatures.slice(start, start + MAX_ROWS).forEach((sig, j) => {
        const i = start + j;
        const row = document.createElement("div");
        row.className = "cm-lsp-signature-row";
        if (i === activeSignature) row.classList.add("cm-lsp-signature-active");
        else if (!acceptsParameter(sig, activeParameter)) row.classList.add("cm-lsp-signature-disabled");
        const parts = splitSignature(sig.label, sig.parameters, activeParameter);
        row.append(parts.before);
        if (parts.param) {
          const b = document.createElement("b");
          b.textContent = parts.param;
          row.appendChild(b);
        }
        row.append(parts.after);
        dom.appendChild(row);
      });
      const doc = signatures[activeSignature]?.documentation;
      if (doc && !isEmptyMarkup(doc) && signatures.length === 1) {
        const d = renderMarkup(doc);
        d.classList.add("cm-lsp-signature-doc");
        dom.appendChild(d);
      }
      return { dom };
    },
  };
}

async function fetchSignature(view: EditorView, explicit: boolean) {
  const doc = docOf(view);
  if (!doc) return;
  const state = view.state;
  const head = state.selection.main.head;
  try {
    const help = await lspRequest(() => commands.lspSignatureHelp(doc.doc, offsetToPos(state.doc, head)));
    if (view.state.doc !== state.doc && !explicit) return;
    const current = view.state.field(signatureField, false);
    if (!help || !help.signatures.length) {
      if (current) view.dispatch({ effects: setSignature.of(null) });
      if (explicit) showHint(view, "No parameters");
      return;
    }
    view.dispatch({ effects: setSignature.of({ pos: Math.min(head, view.state.doc.length), help }) });
  } catch (e) {
    if (view.state.field(signatureField, false)) view.dispatch({ effects: setSignature.of(null) });
    reportLspError(view, e, explicit);
  }
}

/** ⌘P or the completion command `editor.action.triggerParameterHints`. */
export function triggerSignatureHelp(view: EditorView, explicit = false) {
  void fetchSignature(view, explicit);
}

const signaturePlugin = ViewPlugin.fromClass(
  class {
    private refresh = debounce(() => void fetchSignature(this.view, false), 120);
    private popupTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(private view: EditorView) {}
    /** Code Completion › "Show the parameter info popup in N ms". */
    private autoPopup() {
      const p = editorPrefs().completion;
      if (!p.parameterInfo) return;
      clearTimeout(this.popupTimer);
      this.popupTimer = setTimeout(() => void fetchSignature(this.view, false), Math.max(0, p.parameterInfoDelay));
    }
    update(u: ViewUpdate) {
      const active = u.state.field(signatureField, false);
      let typedTrigger = false;
      if (u.docChanged && u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("input.complete"))) {
        // The character before the caret: `(` is followed by an auto-inserted `)`.
        const head = u.state.selection.main.head;
        const before = u.state.sliceDoc(Math.max(0, head - 1), head);
        typedTrigger = before === "(" || before === ",";
      }
      if (typedTrigger && !active) this.autoPopup();
      else if (typedTrigger || (active && (u.docChanged || u.selectionSet))) this.refresh();
    }
    destroy() {
      clearTimeout(this.popupTimer);
      this.refresh.cancel();
    }
  },
);

export function signatureExtension(): Extension {
  return [
    signatureField,
    signaturePlugin,
    // Highest: Escape closes parameter info before it leaves a snippet.
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            if (!view.state.field(signatureField, false)) return false;
            view.dispatch({ effects: setSignature.of(null) });
            return true;
          },
        },
      ]),
    ),
    EditorView.focusChangeEffect.of((state, focusing) =>
      !focusing && state.field(signatureField, false) ? setSignature.of(null) : null,
    ),
  ];
}
