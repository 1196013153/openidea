/**
 * Settings › Debugger › Data Views › "Show value tooltip on mouse hover":
 * while suspended, hovering an expression (or the selection under the mouse)
 * evaluates it in the selected frame.
 */
import type { Extension } from "@codemirror/state";
import { hoverTooltip, type EditorView } from "@codemirror/view";
import { workflowSettings } from "@/platform/workflowSettings";
import { activeSession, evaluate } from "../state";
import { inlineValue } from "../values";
import styles from "./editor.module.css";

const BASE_HOVER = 100;
const IDENT = /[\p{L}\p{N}_$]/u;

/** Identifier (with `a.b.c` member access) around `pos`, or the selection containing it. */
export function expressionAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty && pos >= sel.from && pos <= sel.to) {
    const text = state.sliceDoc(sel.from, sel.to).trim();
    return text && !text.includes("\n") ? { from: sel.from, to: sel.to, text } : null;
  }
  const line = state.doc.lineAt(pos);
  const t = line.text;
  let start = pos - line.from;
  let end = start;
  if (!IDENT.test(t[end] ?? "") && !IDENT.test(t[start - 1] ?? "")) return null;
  while (end < t.length && IDENT.test(t[end]!)) end++;
  while (start > 0 && (IDENT.test(t[start - 1]!) || (t[start - 1] === "." && IDENT.test(t[start - 2] ?? "")))) start--;
  const text = t.slice(start, end);
  if (!text || /^\d/.test(text)) return null;
  return { from: line.from + start, to: line.from + end, text };
}

export function valueTooltip(): Extension {
  return hoverTooltip(
    async (view, pos) => {
      const dbg = workflowSettings().debugger;
      if (!dbg.valueTooltip) return null;
      const session = activeSession();
      if (!session || session.status !== "paused") return null;
      const expr = expressionAt(view, pos);
      if (!expr) return null;
      if (dbg.valueTooltipDelay > BASE_HOVER) await new Promise((r) => setTimeout(r, dbg.valueTooltipDelay - BASE_HOVER));
      let value;
      try {
        value = await evaluate(expr.text, "hover", session);
      } catch {
        return null;
      }
      return {
        pos: expr.from,
        end: expr.to,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = styles.valueTooltip!;
          const name = document.createElement("span");
          name.className = styles.valueName!;
          name.textContent = `${expr.text} = `;
          dom.append(name, inlineValue(value.value, 400));
          if (value.typeName) {
            const type = document.createElement("span");
            type.className = styles.valueType!;
            type.textContent = `  {${value.typeName}}`;
            dom.append(type);
          }
          return { dom };
        },
      };
    },
    { hoverTime: BASE_HOVER },
  );
}
