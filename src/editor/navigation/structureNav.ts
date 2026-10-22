/**
 * Outline-based navigation: Next / Previous Method (⌃⇧↓ / ⌃⇧↑) and Super
 * Method (⌘U). The outline is the language server's document symbols, or
 * tree-sitter's without a server (`doc_outline`).
 */
import type { HierarchyItem, Location, OutlineItem, Pos, SymbolKind } from "@/platform/ipc";

const METHODS = new Set<SymbolKind>(["function", "method", "constructor"]);
const TYPES = new Set<SymbolKind>(["class", "interface", "struct", "enum", "trait", "module", "namespace"]);

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.col <= b.col);
const inside = (i: OutlineItem, p: Pos) => before(i.range.start, p) && before(p, i.range.end);

/** Navigation stops of Next / Previous Method: methods and types, in document order. */
export function methodStops(outline: readonly OutlineItem[]): Pos[] {
  const out: Pos[] = [];
  const walk = (items: readonly OutlineItem[]) => {
    for (const i of items) {
      if (METHODS.has(i.kind) || TYPES.has(i.kind)) out.push(i.selection_range.start);
      walk(i.children);
    }
  };
  walk(outline);
  const key = (p: Pos) => p.line * 1e6 + p.col;
  return [...new Map(out.map((p) => [key(p), p])).values()].sort((a, b) => key(a) - key(b));
}

/** The next (dir 1) / previous (-1) stop from `caret`, comparing by line like IDEA. */
export function methodStop(outline: readonly OutlineItem[], caret: Pos, dir: 1 | -1): Pos | null {
  const stops = methodStops(outline);
  if (dir === 1) return stops.find((p) => p.line > caret.line) ?? null;
  for (let i = stops.length - 1; i >= 0; i--) {
    const p = stops[i]!;
    if (p.line < caret.line || (p.line === caret.line && p.col < caret.col)) return p;
  }
  return null;
}

export interface CaretMember {
  /** Innermost method at the caret. */
  method: OutlineItem | null;
  /** Innermost type around the caret (around `method` when there is one). */
  type: OutlineItem | null;
}

export function memberAt(outline: readonly OutlineItem[], caret: Pos): CaretMember {
  let method: OutlineItem | null = null;
  let type: OutlineItem | null = null;
  let level: readonly OutlineItem[] = outline;
  for (;;) {
    const hit = level.find((i) => inside(i, caret));
    if (!hit) break;
    if (METHODS.has(hit.kind)) method = hit;
    else if (TYPES.has(hit.kind) && !method) type = hit;
    level = hit.children;
  }
  return { method, type };
}

/** `beta(int)` (jdtls) and `beta` name the same method. */
export const baseName = (name: string) => name.replace(/\s*[(<].*$/, "");

/** Methods named `name` directly inside the type declared at `item` (its outline node found by position). */
export function methodsInType(outline: readonly OutlineItem[], item: HierarchyItem, name: string): OutlineItem[] {
  const at = item.selectionRange.start;
  const find = (items: readonly OutlineItem[]): OutlineItem | null => {
    for (const i of items) {
      if (TYPES.has(i.kind) && i.selection_range.start.line === at.line) return i;
      const deeper = inside(i, at) ? find(i.children) : null;
      if (deeper) return deeper;
    }
    return null;
  };
  const type = find(outline);
  const bare = baseName(name);
  return type ? type.children.filter((c) => METHODS.has(c.kind) && baseName(c.name) === bare) : [];
}

export interface SuperDeps {
  supertypes: (path: string, pos: Pos) => Promise<HierarchyItem[]>;
  outline: (path: string) => Promise<OutlineItem[]>;
}

/** Super methods of `method` (a member of the type at `typePos`), searching up to `depth` levels of supertypes. */
export async function superMethods(path: string, typePos: Pos, method: string, deps: SuperDeps, depth = 3): Promise<Location[]> {
  let level: Array<{ path: string; pos: Pos }> = [{ path, pos: typePos }];
  const seen = new Set<string>();
  for (let d = 0; d < depth && level.length; d++) {
    const next: Array<{ path: string; pos: Pos }> = [];
    const found: Location[] = [];
    for (const t of level) {
      const supers = await deps.supertypes(t.path, t.pos).catch(() => [] as HierarchyItem[]);
      for (const s of supers) {
        const key = `${s.path}:${s.selectionRange.start.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const methods = methodsInType(await deps.outline(s.path).catch(() => [] as OutlineItem[]), s, method);
        if (methods.length) for (const m of methods) found.push({ path: s.path, range: m.selection_range });
        else next.push({ path: s.path, pos: s.selectionRange.start });
      }
    }
    if (found.length) return found;
    level = next;
  }
  return [];
}
