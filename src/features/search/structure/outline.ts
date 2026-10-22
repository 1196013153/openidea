import type { OutlineItem, Pos } from "@/platform/ipc";
import { matchText } from "../common/rank";

export interface OutlineNode {
  key: string;
  item: OutlineItem;
  children: OutlineNode[];
}

/** Stable keys: parent key + name + occurrence index among same-named siblings. */
export function keyOutline(items: readonly OutlineItem[], parent = ""): OutlineNode[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item.name) ?? 0;
    seen.set(item.name, n + 1);
    const key = `${parent}/${item.kind}:${item.name}${n ? `#${n}` : ""}`;
    return { key, item, children: keyOutline(item.children ?? [], key) };
  });
}

export function sortOutline(nodes: readonly OutlineNode[], alphabetical: boolean): OutlineNode[] {
  if (!alphabetical) return nodes as OutlineNode[];
  return [...nodes]
    .sort((a, b) => a.item.name.localeCompare(b.item.name, undefined, { sensitivity: "base" }))
    .map((n) => ({ ...n, children: sortOutline(n.children, true) }));
}

const cmp = (a: Pos, b: Pos) => a.line - b.line || a.col - b.col;

function contains(item: OutlineItem, pos: Pos): boolean {
  return cmp(item.range.start, pos) <= 0 && cmp(pos, item.range.end) <= 0;
}

/** Keys from the root to the innermost symbol containing `pos` (empty if none). */
export function symbolPathAt(nodes: readonly OutlineNode[], pos: Pos): string[] {
  for (const n of nodes) {
    if (contains(n.item, pos)) return [n.key, ...symbolPathAt(n.children, pos)];
  }
  return [];
}

export function allKeys(nodes: readonly OutlineNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children.length) out.push(n.key);
    allKeys(n.children, out);
  }
  return out;
}

export interface FlatOutlineRow {
  node: OutlineNode;
  depth: number;
  indices: number[];
  /** Matches the filter itself (vs. shown as an ancestor of a match). */
  matched: boolean;
  score: number;
}

/** Depth-first rows for the File Structure popup; with a filter, keeps matches and their ancestors. */
export function flattenOutline(nodes: readonly OutlineNode[], query: string): FlatOutlineRow[] {
  const out: FlatOutlineRow[] = [];
  const q = query.trim();
  const walk = (list: readonly OutlineNode[], depth: number): boolean => {
    let any = false;
    for (const node of list) {
      const hit = q ? matchText(node.item.name, q) : { score: 0, indices: [] };
      const at = out.length;
      out.push({ node, depth, indices: hit?.indices ?? [], matched: !!hit, score: hit?.score ?? -Infinity });
      const child = walk(node.children, depth + 1);
      if (!hit && !child) out.splice(at, 1);
      else any = true;
    }
    return any;
  };
  walk(nodes, 0);
  return out;
}

/** Best-scoring matched row (the popup preselects it while filtering). */
export function bestRow(rows: readonly FlatOutlineRow[]): number {
  let best = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]!.matched) continue;
    if (best < 0 || rows[i]!.score > rows[best]!.score) best = i;
  }
  return best;
}
