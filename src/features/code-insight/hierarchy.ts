/** Call / type hierarchy state, with lazily expanded levels. */
import { create } from "zustand";
import type { HierarchyDirection, HierarchyItem } from "@/bindings";
import { commands } from "@/platform/ipc";
import { toolWindowService } from "@/workbench/contributions";
import { basename } from "@/platform/project";
import { caretContext, hint, lspRequest, reportError, withDocument } from "./ipc";

export type HierarchyMode = "call" | "type";

export interface HierarchyNode {
  id: string;
  item: HierarchyItem;
}

export interface HierarchyRoot {
  name: string;
  path: string;
  line: number;
  col: number;
}

interface HierarchyState {
  mode: HierarchyMode;
  direction: HierarchyDirection;
  root: HierarchyRoot | null;
  /** Parent id ("root" for the top level) → loaded children. */
  children: ReadonlyMap<string, HierarchyNode[]>;
  /** Parent ids whose children failed to load. */
  failed: ReadonlySet<string>;
  loading: boolean;
  /** Bumped per (re)query so stale responses are dropped and the tree resets. */
  generation: number;
}

export const ROOT_ID = "root";

export const useHierarchy = create<HierarchyState>(() => ({
  mode: "call",
  direction: "incoming",
  root: null,
  children: new Map(),
  failed: new Set(),
  loading: false,
  generation: 0,
}));

/** The window switched projects: the tree refers to the previous one's documents. */
export function resetHierarchy() {
  useHierarchy.setState((s) => ({
    root: null,
    children: new Map(),
    failed: new Set(),
    loading: false,
    generation: s.generation + 1,
  }));
}

export function directionLabel(mode: HierarchyMode, direction: HierarchyDirection): string {
  if (mode === "call") return direction === "incoming" ? "Callers" : "Callees";
  return direction === "incoming" ? "Supertypes" : "Subtypes";
}

function request(mode: HierarchyMode, doc: number, line: number, col: number, direction: HierarchyDirection) {
  return lspRequest(() =>
    mode === "call"
      ? commands.lspCallHierarchy(doc, { line, col }, direction)
      : commands.lspTypeHierarchy(doc, { line, col }, direction),
  );
}

export function childId(parent: string, item: HierarchyItem): string {
  const p = item.selectionRange.start;
  return `${parent}/${item.path}:${p.line}:${p.col}:${item.name}`;
}

function setChildren(generation: number, parent: string, items: HierarchyItem[]) {
  const s = useHierarchy.getState();
  if (s.generation !== generation) return;
  const seen = new Set<string>();
  const nodes: HierarchyNode[] = [];
  for (const item of items) {
    const id = childId(parent, item);
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, item });
  }
  useHierarchy.setState({ children: new Map(s.children).set(parent, nodes) });
}

async function loadRoot() {
  const s = useHierarchy.getState();
  const root = s.root;
  if (!root) return;
  const generation = s.generation + 1;
  useHierarchy.setState({ generation, children: new Map(), failed: new Set(), loading: true });
  try {
    const items = await withDocument(root.path, (doc) => request(s.mode, doc, root.line, root.col, s.direction));
    setChildren(generation, ROOT_ID, items);
  } catch (e) {
    if (useHierarchy.getState().generation === generation)
      useHierarchy.setState((st) => ({ failed: new Set(st.failed).add(ROOT_ID) }));
    reportError(e);
  } finally {
    if (useHierarchy.getState().generation === generation) useHierarchy.setState({ loading: false });
  }
}

export async function loadChildren(node: HierarchyNode) {
  const { mode, direction, generation } = useHierarchy.getState();
  const at = node.item.selectionRange.start;
  try {
    const items = await withDocument(node.item.path, (doc) => request(mode, doc, at.line, at.col, direction));
    setChildren(generation, node.id, items);
  } catch (e) {
    if (useHierarchy.getState().generation !== generation) return;
    useHierarchy.setState((st) => ({
      failed: new Set(st.failed).add(node.id),
      children: new Map(st.children).set(node.id, []),
    }));
    reportError(e);
  }
}

export async function showHierarchy(mode: HierarchyMode) {
  const c = caretContext();
  if (!c) {
    hint("Open a file to show the hierarchy");
    return;
  }
  const s = useHierarchy.getState();
  const direction = s.mode === mode ? s.direction : mode === "call" ? "incoming" : "outgoing";
  useHierarchy.setState({
    mode,
    direction,
    root: { name: c.word ?? basename(c.path), path: c.path, line: c.line, col: c.col },
  });
  toolWindowService().show("hierarchy");
  await loadRoot();
}

export function setDirection(direction: HierarchyDirection) {
  if (useHierarchy.getState().direction === direction) return;
  useHierarchy.setState({ direction });
  void loadRoot();
}

export function refreshHierarchy() {
  void loadRoot();
}
