/** State of the caret-anchored chooser (⌘J, Surround With, postfix expression). */
import { create } from "zustand";

export interface ChooserItem {
  key: string;
  label: string;
  detail?: string;
  /** Matched against the filter in addition to the label. */
  search?: string;
}

export interface ChooserRequest {
  title: string;
  anchor: { x: number; y: number };
  items: ChooserItem[];
  /** Initial filter (typed prefix for ⌘J). */
  filter?: string;
  /** Allow typing to filter. */
  filterable?: boolean;
  /** Shown when nothing matches. */
  emptyText?: string;
  onPick: (item: ChooserItem, filter: string) => void;
  onCancel?: () => void;
}

export const useChooser = create<{ request: ChooserRequest | null; seq: number }>(() => ({ request: null, seq: 0 }));

export function showChooser(r: ChooserRequest) {
  const prev = useChooser.getState().request;
  prev?.onCancel?.();
  useChooser.setState((s) => ({ request: r, seq: s.seq + 1 }));
}

export function closeChooser() {
  useChooser.setState({ request: null });
}
