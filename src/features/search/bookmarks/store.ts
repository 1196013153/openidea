/**
 * Line bookmarks (F3), persisted per project in localStorage. A bookmark may
 * carry a mnemonic (0-9 / A-Z, unique: ⌥F3, ⌃⇧digit) and a description.
 */
import { create } from "zustand";
import { loadJson, saveJson } from "../common/open";

export interface Bookmark {
  path: string;
  /** 0-based. */
  line: number;
  /** Line text when the bookmark was set / last moved. */
  text: string;
  created: number;
  /** `0`-`9` or `A`-`Z`; at most one bookmark has each. */
  mnemonic?: string;
  /** User text shown instead of the line (F3 on a selection, Rename). */
  description?: string;
}

export const MNEMONICS = [..."1234567890", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

export function isMnemonic(c: unknown): c is string {
  return typeof c === "string" && /^[0-9A-Z]$/.test(c);
}

const KEY_PREFIX = "openidea.bookmarks.v1:";

// --- pure helpers -----------------------------------------------------------

export function sortBookmarks(list: readonly Bookmark[]): Bookmark[] {
  return [...list].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

export function hasBookmark(list: readonly Bookmark[], path: string, line: number): boolean {
  return list.some((b) => b.path === path && b.line === line);
}

export function bookmarkAt(list: readonly Bookmark[], path: string, line: number): Bookmark | undefined {
  return list.find((b) => b.path === path && b.line === line);
}

const clip = (text: string) => text.trim().slice(0, 200);

/** F3: removes the line's bookmark or adds one (`description`: the selected text, as IDEA). */
export function toggleBookmark(
  list: readonly Bookmark[],
  path: string,
  line: number,
  text: string,
  now = Date.now(),
  description?: string | null,
): Bookmark[] {
  if (hasBookmark(list, path, line)) return list.filter((b) => !(b.path === path && b.line === line));
  const b: Bookmark = { path, line, text: clip(text), created: now };
  if (description?.trim()) b.description = clip(description);
  return sortBookmarks([...list, b]);
}

/**
 * Gives the line's bookmark (created if needed) `mnemonic`, taking it from any
 * other bookmark; `null` turns it into a plain bookmark. `description` replaces
 * the description when given (empty clears it).
 */
export function assignMnemonic(
  list: readonly Bookmark[],
  path: string,
  line: number,
  text: string,
  mnemonic: string | null,
  description?: string,
  now = Date.now(),
): Bookmark[] {
  const here = (b: Bookmark) => b.path === path && b.line === line;
  const out = list.filter((b) => !here(b)).map((b) => (mnemonic && b.mnemonic === mnemonic ? withoutMnemonic(b) : b));
  const b: Bookmark = { ...(list.find(here) ?? { path, line, text: clip(text), created: now }) };
  if (mnemonic) b.mnemonic = mnemonic;
  else delete b.mnemonic;
  if (description !== undefined) {
    if (description.trim()) b.description = clip(description);
    else delete b.description;
  }
  return sortBookmarks([...out, b]);
}

function withoutMnemonic(b: Bookmark): Bookmark {
  const { mnemonic: _, ...rest } = b;
  return rest;
}

/** ⌃⇧digit: the line already has `mnemonic` → remove the bookmark; otherwise assign it. */
export function toggleMnemonic(list: readonly Bookmark[], path: string, line: number, text: string, mnemonic: string): Bookmark[] {
  if (bookmarkAt(list, path, line)?.mnemonic === mnemonic) return list.filter((b) => !(b.path === path && b.line === line));
  return assignMnemonic(list, path, line, text, mnemonic);
}

export function bookmarkByMnemonic(list: readonly Bookmark[], mnemonic: string): Bookmark | undefined {
  return list.find((b) => b.mnemonic === mnemonic);
}

/** Rename (F2 in the Bookmarks view): an empty description shows the line again. */
export function describeBookmark(list: readonly Bookmark[], path: string, line: number, description: string): Bookmark[] {
  return list.map((b) => {
    if (b.path !== path || b.line !== line) return b;
    const { description: _, ...rest } = b;
    return description.trim() ? { ...rest, description: clip(description) } : rest;
  });
}

/** What the Bookmarks view and popup show for a bookmark. */
export function bookmarkLabel(b: Bookmark): string {
  return b.description?.trim() || b.text.trim();
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
    const prev = old[i];
    const b: Bookmark = { path, line: l.line, text: clip(l.text), created: prev?.created ?? Date.now() };
    if (prev?.mnemonic) b.mnemonic = prev.mnemonic;
    if (prev?.description) b.description = prev.description;
    moved.push(b);
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

/** Lines of `path`'s bookmarks with their mnemonics (gutter), sorted by line. */
export function marksOf(list: readonly Bookmark[], path: string): Array<{ line: number; mnemonic: string | null }> {
  return list
    .filter((b) => b.path === path)
    .map((b) => ({ line: b.line, mnemonic: b.mnemonic ?? null }))
    .sort((a, b) => a.line - b.line);
}

function sanitize(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  return sortBookmarks(
    raw.filter(
      (b): b is Bookmark =>
        !!b && typeof b === "object" && typeof (b as Bookmark).path === "string" && Number.isInteger((b as Bookmark).line),
    ).map((b) => {
      const out: Bookmark = { path: b.path, line: Math.max(0, b.line), text: String(b.text ?? ""), created: Number(b.created) || 0 };
      if (isMnemonic(b.mnemonic)) out.mnemonic = b.mnemonic;
      if (typeof b.description === "string" && b.description.trim()) out.description = b.description;
      return out;
    }),
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

// --- popups -----------------------------------------------------------------

export interface MnemonicTarget {
  path: string;
  line: number;
  /** Line text, for a bookmark created by the chooser. */
  text: string;
  /** Where to show the chooser (the caret); centred without. */
  at?: { x: number; y: number };
}

interface BookmarkPopupsState {
  /** ⌥F3: the mnemonic chooser for this line. */
  chooser: MnemonicTarget | null;
  /** ⌘F3: the Bookmarks popup. */
  list: boolean;
  /** Edit Description dialog (F2 in the Bookmarks view / popup). */
  editing: { path: string; line: number } | null;
}

export const useBookmarkPopups = create<BookmarkPopupsState>(() => ({ chooser: null, list: false, editing: null }));
