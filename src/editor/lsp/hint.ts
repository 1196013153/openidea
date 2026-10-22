/**
 * Transient editor hints (IDEA's balloon at the caret): "No language server
 * available", "Cannot find declaration to go to", error messages on F2…
 * Dismissed by the next edit / caret move, Escape, or after a timeout.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { Prec } from "@codemirror/state";

interface Hint {
  pos: number;
  content: string | (() => HTMLElement);
  tone: "info" | "error" | "warning";
}

const setHint = StateEffect.define<Hint | null>();

const hintField = StateField.define<Hint | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHint)) return e.value;
    if (value && (tr.docChanged || tr.selection)) return null;
    return value;
  },
  provide: (f) =>
    showTooltip.from(f, (h): Tooltip | null =>
      h
        ? {
            pos: h.pos,
            above: true,
            strictSide: false,
            create: () => {
              const dom = document.createElement("div");
              dom.className = `cm-lsp-hint cm-lsp-hint-${h.tone}`;
              dom.setAttribute("role", "status");
              if (typeof h.content === "string") dom.textContent = h.content;
              else dom.appendChild(h.content());
              return { dom };
            },
          }
        : null,
    ),
});

const timers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

export function showHint(
  view: EditorView,
  content: Hint["content"],
  opts: { pos?: number; tone?: Hint["tone"]; timeout?: number } = {},
) {
  const pos = opts.pos ?? view.state.selection.main.head;
  const effects: StateEffect<unknown>[] = [setHint.of({ pos, content, tone: opts.tone ?? "info" })];
  if (!view.state.field(hintField, false)) effects.push(StateEffect.appendConfig.of(hintExtension()));
  view.dispatch({ effects });
  clearTimeout(timers.get(view));
  timers.set(
    view,
    setTimeout(() => {
      if (view.state.field(hintField, false)) view.dispatch({ effects: setHint.of(null) });
    }, opts.timeout ?? 4000),
  );
}

export function hideHint(view: EditorView): boolean {
  if (!view.state.field(hintField, false)) return false;
  view.dispatch({ effects: setHint.of(null) });
  return true;
}

export function hintExtension(): Extension {
  return [
    hintField,
    Prec.high(keymap.of([{ key: "Escape", run: (view) => hideHint(view) }])),
  ];
}
