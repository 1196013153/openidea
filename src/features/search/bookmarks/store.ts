/** Line bookmarks (F3), persisted per project in localStorage. */
import { create } from "zustand";
import { loadJson, saveJson } from "../common/open";

export interface Bookmark {
  path: string;
  /** 0-based. */
  line: number;
  /** Line text when the bookmark was set / last moved. */
  text: string;
  created: number;
}

const KEY_PREFIX = "openidea.bookmarks.v1:";

// --- pure helpers -----------------------------------------------------------

export function sortBookmarks(list: readonly Bookmark[]): Bookmark[] {
  return [...list].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

export function hasBookmark(list: readonly Bookmark[], path: string, line: number): boolean {
  return list.some((b) => b.path === path && b.line === line);
}

export function toggleBookmark(list: readonly Bookmark[], path: string, line: number, text: string, now = Date.now()): Bookmark[] {
  if (hasBookmark(list, path, line)) return list.filter((b) => !(b.path === path && b.line === line));
  return sortBookmarks([...list, { path, line, text: text.trim().slice(0, 200), created: now }]);
}

export function removeBookmarks(list: readonly Bookmark[], pred: (b: Bookmark) => boolean): Bookmark[] {
  return list.filter((b) => !pred(b));
}

/**
 * Replaces the lines of `path`'s bookmarks after an edit moved them
 * (`lines` in the same order as the file's current bookmarks; duplicates collapse).
 */
export function setFileLines(
  list: readonly Bookmark[],
  path: string,
  lines: ReadonlyArray<{ line: number; text: string }>,
): Bookmark[] {
  const old = list.filter((b) => b.path === path);
  const seen = new Set<number>();
  const moved: Bookmark[] = [];
  lines.forEach((l, i) => {
    if (seen.has(l.line)) return;
    seen.add(l.line);
    moved.push({ path, line: l.line, text: l.text.trim().slice(0, 200), created: old[i]?.created ?? Date.now() });
  });
  return sortBookmarks([...list.filter((b) => b.path !== path), ...moved]);
}

export function renameBookmarks(list: readonly Bookmark[], from: string, to: string | null): Bookmark[] {
  const out: Bookmark[] = [];
  for (const b of list) {
    if (b.path === from || b.path.startsWith(from + "/")) {
      if (to !== null) out.push({ ...b, path: to + b.path.slice(from.length) });
    } else out.push(b);
  }
  return sortBookmarks(out);
}

export function linesOf(list: readonly Bookmark[], path: string): number[] {
  return list.filter((b) => b.path === path).map((b) => b.line).sort((a, b) => a - b);
}

function sanitize(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  return sortBookmarks(
    raw.filter(
      (b): b is Bookmark =>
        !!b && typeof b === "object" && typeof (b as Bookmark).path === "string" && Number.isInteger((b as Bookmark).line),
    ).map((b) => ({ path: b.path, line: Math.max(0, b.line), text: String(b.text ?? ""), created: Number(b.created) || 0 })),
  );
}

// --- store ------------------------------------------------------------------

interface BookmarksState {
  scope: string | null;
  items: Bookmark[];
}

export const useBookmarks = create<BookmarksState>(() => ({ scope: null, items: [] }));

export function loadBookmarks(scope: string | null) {
  useBookmarks.setState({ scope, items: scope ? sanitize(loadJson<unknown>(KEY_PREFIX + scope, [])) : [] });
}

export function updateBookmarks(fn: (list: readonly Bookmark[]) => Bookmark[]) {
  const { scope, items } = useBookmarks.getState();
  const next = fn(items);
  if (next === items) return;
  useBookmarks.setState({ items: next });
  if (scope) saveJson(KEY_PREFIX + scope, next);
}
