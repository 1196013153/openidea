import type { ToolWindowContribution } from "@/workbench/contributions";
import { basename, relDir } from "../common/open";
import type { RecentLocation } from "../common/locations";
import { matchText } from "../common/rank";
import { isVirtualUri, virtualContainer } from "@/platform/virtualDocs";

export interface RecentFileItem {
  path: string;
  rel: string;
  name: string;
  dir: string;
  indices: number[];
}

export function filterRecentFiles(
  paths: readonly string[],
  query: string,
  opts: { root: string | null; edited?: ReadonlySet<string>; editedOnly?: boolean },
): RecentFileItem[] {
  const out: RecentFileItem[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (opts.editedOnly && !opts.edited?.has(path)) continue;
    const rel = opts.root && path.startsWith(opts.root + "/") ? path.slice(opts.root.length + 1) : path;
    const name = basename(rel);
    let indices: number[] = [];
    if (query.trim()) {
      const hit = matchText(name, query);
      if (hit) indices = hit.indices;
      else if (!matchText(rel, query)) continue;
    }
    out.push({ path, rel, name, dir: isVirtualUri(path) ? virtualContainer(path) : relDir(rel), indices });
  }
  return out;
}

/** IDEA preselects the previous file so ⌘E ↵ toggles between the last two. */
export function initialFileIndex(items: readonly RecentFileItem[], activePath: string | null, query: string): number {
  if (!items.length) return -1;
  if (!query && items.length > 1 && items[0]!.path === activePath) return 1;
  return 0;
}

/** Switcher (⌃⇥) files: only open editors, most recently opened first. */
export function switcherPaths(recent: readonly string[], open: readonly string[]): string[] {
  const isOpen = new Set(open);
  const out = [...new Set(recent.filter((p) => isOpen.has(p)))];
  const listed = new Set(out);
  for (const p of open) if (!listed.has(p)) out.push(p);
  return out;
}

/**
 * Switcher selection `step` rows away from file row `base`: moving past the end
 * of one column continues in the other (files, then tool windows), like IDEA.
 */
export function switcherSelection(
  base: number,
  step: number,
  files: number,
  tools: number,
): { column: "files" | "tools"; index: number } | null {
  const n = files + tools;
  if (!n) return null;
  const at = (((base + step) % n) + n) % n;
  return at < files ? { column: "files", index: at } : { column: "tools", index: at - files };
}

const ANCHOR_ORDER = { left: 0, bottom: 1, right: 2 } as const;

export function switcherToolWindows(
  windows: Iterable<ToolWindowContribution>,
  projectOpen: boolean,
  query: string,
): Array<{ tw: ToolWindowContribution; indices: number[] }> {
  const list = [...windows]
    .filter((tw) => projectOpen || tw.requiresProject === false)
    .sort(
      (a, b) =>
        ANCHOR_ORDER[a.anchor] - ANCHOR_ORDER[b.anchor] ||
        Number(!!a.secondary) - Number(!!b.secondary) ||
        (a.order ?? 0) - (b.order ?? 0),
    );
  if (!query.trim()) return list.map((tw) => ({ tw, indices: [] }));
  const out: Array<{ tw: ToolWindowContribution; indices: number[] }> = [];
  for (const tw of list) {
    const hit = matchText(tw.title, query);
    if (hit) out.push({ tw, indices: hit.indices });
  }
  return out;
}

export function filterLocations(
  list: readonly RecentLocation[],
  query: string,
  opts: { changedOnly: boolean; root: string | null },
): Array<RecentLocation & { rel: string; nameIndices: number[] }> {
  const q = query.trim().toLowerCase();
  const out: Array<RecentLocation & { rel: string; nameIndices: number[] }> = [];
  for (const l of list) {
    if (opts.changedOnly && !l.changed) continue;
    const rel = opts.root && l.path.startsWith(opts.root + "/") ? l.path.slice(opts.root.length + 1) : l.path;
    let nameIndices: number[] = [];
    if (q) {
      const hit = matchText(basename(rel), q);
      if (hit) nameIndices = hit.indices;
      else if (!l.snippet.some((s) => s.toLowerCase().includes(q)) && !rel.toLowerCase().includes(q)) continue;
    }
    out.push({ ...l, rel, nameIndices });
  }
  return out;
}
