/** State of the React popups the LSP editor features open (rendered by `Popups.tsx`). */
import { create } from "zustand";
import type { EditorView } from "@codemirror/view";
import type { Location, Markup } from "@/bindings";
import type { WorkspaceEditSummary } from "./workspaceEdit";

export interface PopupPoint {
  x: number;
  y: number;
}

export interface ListPopupItem {
  id: string;
  label: string;
  /** Muted trailing text (file:line, kind…). */
  detail?: string;
  /** Second line / muted text after the label (code preview). */
  preview?: string;
  icon?: string;
  /** Symbol badge kind (`ui/icons` `SymbolBadge`) shown instead of an icon. */
  symbol?: string;
  emphasis?: boolean;
  /** Disabled reason; disabled rows are shown but not activatable. */
  disabled?: string | null;
  shortcut?: string;
  run: () => void | Promise<void>;
}

export type LspPopup =
  | { kind: "doc"; anchor: PopupPoint; markup: Markup; language: string | null; themeClasses: string }
  | {
      kind: "definition";
      anchor: PopupPoint;
      location: Location;
      firstLine: number;
      text: string;
      language: string | null;
      themeClasses: string;
    }
  | { kind: "list"; anchor: PopupPoint; title: string; items: ListPopupItem[] }
  | {
      kind: "rename";
      anchor: PopupPoint;
      title: string;
      initial: string;
      /** Muted line under the input, e.g. that the rename is based on syntax only. */
      note?: string;
      /** Name suggestions listed under the input (↑↓ to pick), e.g. for Introduce Variable. */
      suggestions?: string[];
      /** Replaces the default "↵ Rename · Esc Cancel" footer. */
      hint?: string;
      onSubmit: (name: string) => void;
    }
  | {
      kind: "preview";
      title: string;
      summary: WorkspaceEditSummary;
      confirmLabel: string;
      onConfirm: () => void;
      /** Why confirmation is needed (shown as warnings above the changes). */
      warnings?: string[];
      /** Individual occurrences with line previews (single-file syntax-based renames). */
      occurrences?: PreviewOccurrence[];
    };

export interface PreviewOccurrence {
  line: number;
  /** The line's text and the occurrence within it. */
  text: string;
  from: number;
  to: number;
}

interface PopupState {
  popup: LspPopup | null;
  /** Bumped per open so React remounts a popup of the same kind. */
  seq: number;
}

export const useLspPopup = create<PopupState>(() => ({ popup: null, seq: 0 }));

export function openPopup(popup: LspPopup) {
  useLspPopup.setState((s) => ({ popup, seq: s.seq + 1 }));
}

export function closePopup() {
  useLspPopup.setState({ popup: null });
}

/** Screen point just below `pos` (falls back to the editor's top-left). */
export function caretAnchor(view: EditorView, pos: number, side: "below" | "above" = "below"): PopupPoint {
  const c = view.coordsAtPos(pos) ?? view.coordsAtPos(pos, -1);
  if (c) return { x: c.left, y: side === "below" ? c.bottom : c.top };
  const r = view.dom.getBoundingClientRect();
  return { x: r.left + 40, y: r.top + 40 };
}
