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

export interface OutlineFilter {
  /** The tree to show: with `narrow`, only matches and their ancestors. */
  nodes: OutlineNode[];
  /** Match indices into each matching node's name. */
  matches: Map<string, number[]>;
  /** Matching keys in tree order (↑/↓ cycle them when not narrowing). */
  order: string[];
  /** The best-scoring match (preselected while filtering). */
  best: string | null;
}

/** The File Structure popup's speed search: matches keep their ancestors; without `narrow` nothing is hidden. */
export function filterOutline(nodes: readonly OutlineNode[], query: string, narrow: boolean): OutlineFilter {
  const q = query.trim();
  const matches = new Map<string, number[]>();
  const order: string[] = [];
  let best: string | null = null;
  let bestScore = -Infinity;
  const walk = (list: readonly OutlineNode[]): OutlineNode[] => {
    const out: OutlineNode[] = [];
    for (const node of list) {
      const hit = q ? matchText(node.item.name, q, { wordAligned: true }) : null;
      if (hit) {
        matches.set(node.key, hit.indices);
        order.push(node.key);
        if (hit.score > bestScore) {
          best = node.key;
          bestScore = hit.score;
        }
      }
      const children = walk(node.children);
      if (!q || !narrow || hit || children.length)
        out.push(narrow ? { ...node, children } : node);
    }
    return out;
  };
  const filtered = walk(nodes);
  return { nodes: q && narrow ? filtered : (nodes as OutlineNode[]), matches, order, best };
}

/** Parent key of every node (`null` for top-level ones). */
export function parentKeys(nodes: readonly OutlineNode[], parent: string | null = null, out = new Map<string, string | null>()) {
  for (const n of nodes) {
    out.set(n.key, parent);
    parentKeys(n.children, n.key, out);
  }
  return out;
}

/** Rows a tree of `nodes` shows with the `collapsed` keys collapsed. */
export function visibleCount(nodes: readonly OutlineNode[], collapsed: ReadonlySet<string>): number {
  let n = 0;
  for (const node of nodes) n += 1 + (collapsed.has(node.key) ? 0 : visibleCount(node.children, collapsed));
  return n;
}
