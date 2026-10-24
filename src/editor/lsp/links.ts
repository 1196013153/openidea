/**
 * References that Go to Declaration and ⌘-click follow when the language
 * server has no definition there, in every language:
 *  - document links from the server (`textDocument/documentLink`: HTML `href`,
 *    CSS `url()`, Markdown links, `#include`, JSON `$schema`…);
 *  - without one, URLs in the text and quoted strings naming an existing file
 *    (IDEA's file references: `open("data/x.csv")`, `include_str!("a.txt")`).
 */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { call, commands, isTauri, type DocumentLink } from "@/platform/ipc";
import { openExternalUrl } from "@/platform/openUrl";
import { useProject } from "@/platform/project";
import { currentRoots } from "@/platform/projectRoots";
import { editorService } from "@/workbench/contributions";
import { lspRequest } from "./lsp";
import { rangeToOffsets } from "./positions";

export type Reference =
  | { kind: "file"; from: number; to: number; path: string; fragment?: string | null }
  | { kind: "url"; from: number; to: number; url: string }
  /** A quoted path that still has to be resolved against the file system. */
  | { kind: "path"; from: number; to: number; value: string }
  /** A link whose file does not exist (reported, never opened). */
  | { kind: "missing"; from: number; to: number; value: string };

// --- document links ----------------------------------------------------------

const linkCache = new WeakMap<Text, Promise<DocumentLink[]>>();
const fetchedLinks = new WeakMap<Text, DocumentLink[]>();

/** The server's links of the document as it is now (cached per document version). */
export function documentLinks(view: EditorView, doc: EditorDocContext): Promise<DocumentLink[]> {
  const text = view.state.doc;
  let links = linkCache.get(text);
  if (!links) {
    links = whenSynced(view)
      .then(() => lspRequest(() => commands.lspDocumentLinks(doc.doc)))
      .catch(() => [])
      .then((list) => {
        fetchedLinks.set(text, list);
        return list;
      });
    linkCache.set(text, links);
  }
  return links;
}

/** Links already fetched for the current text, if any (the ⌘-hover underline is synchronous). */
export function knownLinks(view: EditorView): DocumentLink[] | undefined {
  return fetchedLinks.get(view.state.doc);
}

export function linkReference(text: Text, links: readonly DocumentLink[], offset: number): Reference | null {
  for (const l of links) {
    const { from, to } = rangeToOffsets(text, l.range);
    if (offset < from || offset > to) continue;
    if (l.path) return { kind: "file", from, to, path: l.path, fragment: l.fragment };
    if (l.url) return { kind: "url", from, to, url: l.url };
  }
  return null;
}

// --- references found in the text -------------------------------------------

const URL_RE = /\b(?:https?:\/\/|mailto:)[^\s"'`<>()[\]{}]+[^\s"'`<>()[\]{},.;:!?]/g;
const QUOTED_RE = /"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\\n]*)`/g;
/** Unquoted targets: Markdown `[x](path)` / `![x](path "title")`, CSS `url(path)`. */
const BARE_RE = /\]\(([^()\s]+)(?:\s+"[^"]*")?\)|\burl\(\s*([^()'"\s]+)\s*\)/g;
const MAX_PATH = 260;

/** Whether a string literal looks like a file path rather than prose or an identifier. */
export function looksLikePath(value: string): boolean {
  if (!value || value.length > MAX_PATH || /^[a-z][\w+.-]*:/i.test(value) || /[\s<>|*?]/.test(value)) return false;
  const bare = value.replace(/[?#].*$/, "");
  return /\//.test(bare) || /^\.{0,2}[\w@~-][\w.@~-]*\.[A-Za-z0-9]{1,8}$/.test(bare);
}

/** A URL or path-like quoted string at `offset`, found on its line. */
export function textReference(text: Text, offset: number): Reference | null {
  const line = text.lineAt(offset);
  const col = offset - line.from;
  for (const m of line.text.matchAll(URL_RE)) {
    if (col >= m.index && col <= m.index + m[0].length)
      return { kind: "url", from: line.from + m.index, to: line.from + m.index + m[0].length, url: m[0] };
  }
  const strings = [
    ...[...line.text.matchAll(QUOTED_RE)].map((m) => ({ value: m[1] ?? m[2] ?? m[3] ?? "", from: m.index + 1 })),
    ...[...line.text.matchAll(BARE_RE)].map((m) => {
      const value = m[1] ?? m[2] ?? "";
      return { value, from: m.index + m[0].indexOf(value) };
    }),
  ];
  for (const { value, from } of strings) {
    if (col < from || col > from + value.length || !looksLikePath(value)) continue;
    return { kind: "path", from: line.from + from, to: line.from + from + value.length, value };
  }
  return null;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

/** `a/./b/../c` → `a/c`. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "." || (seg === "" && out.length)) continue;
    if (seg === ".." && out.length > 1) out.pop();
    else out.push(seg);
  }
  return out.join("/") || "/";
}

/**
 * Where a path-like string may point, most likely first. `/x` resolves against
 * the project root and its resource roots (`resourceRoots`, absolute), like IDEA.
 */
export function pathCandidates(value: string, from: string, root: string | null, resourceRoots: readonly string[] = []): string[] {
  const bare = decodeURIComponentSafe(value.replace(/[?#].*$/, ""));
  const list: string[] = [];
  if (bare.startsWith("/")) {
    if (root) list.push(`${root}${bare}`);
    list.push(...resourceRoots.map((d) => `${d}${bare}`));
    list.push(bare);
  } else if (!bare.startsWith("~")) {
    list.push(`${dirname(from)}/${bare}`);
    if (root && !bare.startsWith("..")) list.push(`${root}/${bare}`);
  }
  return [...new Set(list.map(normalizePath))];
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function isFile(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await call(commands.fsProbe(path));
    return true;
  } catch {
    return false;
  }
}

/** Resolves a `path` reference to an existing file; null when none exists. */
export async function resolvePath(ref: Reference, from: string): Promise<Reference | null> {
  if (ref.kind !== "path") return ref;
  const root = useProject.getState().project?.root ?? null;
  const resources = root
    ? currentRoots()
        .filter((r) => r.kind === "resources")
        .map((r) => (r.path ? `${root}/${r.path}` : root))
    : [];
  for (const path of pathCandidates(ref.value, from, root, resources))
    if (await isFile(path)) return { kind: "file", from: ref.from, to: ref.to, path, fragment: ref.value.split("#")[1] ?? null };
  return null;
}

// --- following ----------------------------------------------------------------

/** The offset a `#fragment` names in `text` of `path`: `L12[,5]`, an element id or a Markdown heading. */
export function fragmentOffset(text: string, path: string, fragment: string): number | null {
  const line = /^L(\d+)(?:[,:C](\d+))?$/i.exec(fragment);
  const lines = text.split("\n");
  if (line) {
    const n = Math.min(Number(line[1]) - 1, lines.length - 1);
    if (n < 0) return null;
    const col = Math.min(Math.max(Number(line[2] ?? 1) - 1, 0), lines[n]!.length);
    return lines.slice(0, n).reduce((a, l) => a + l.length + 1, 0) + col;
  }
  const esc = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/\.(md|markdown|mdx)$/i.test(path)) {
    let offset = 0;
    for (const l of lines) {
      const h = /^#{1,6}\s+(.*?)\s*#*$/.exec(l);
      if (h && slug(h[1]!) === fragment.toLowerCase()) return offset;
      offset += l.length + 1;
    }
    return null;
  }
  const m = new RegExp(`\\b(?:id|name)\\s*=\\s*["']?${esc}(?=["'\\s>])`).exec(text);
  return m ? m.index : null;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

export async function followReference(ref: Reference): Promise<void> {
  if (ref.kind === "missing") throw new Error(`Cannot find file '${ref.value}'`);
  if (ref.kind === "url") {
    await openExternalUrl(ref.url);
    return;
  }
  if (ref.kind !== "file") return;
  let selection: { line: number; col: number } | undefined;
  if (ref.fragment) {
    const text = await call(commands.fsReadText(ref.path)).catch(() => null);
    const offset = text === null ? null : fragmentOffset(text, ref.path, ref.fragment);
    if (text !== null && offset !== null) {
      const before = text.slice(0, offset);
      const line = before.split("\n").length - 1;
      selection = { line, col: offset - (before.lastIndexOf("\n") + 1) };
    }
  }
  await editorService().openFile(ref.path, { focus: true, ...(selection ? { selection } : {}) });
}

/**
 * The reference at `offset`: a server link, else a URL or an existing file
 * named by a quoted path. Null when there is none.
 */
export async function referenceAt(view: EditorView, doc: EditorDocContext, offset: number): Promise<Reference | null> {
  const link = linkReference(view.state.doc, await documentLinks(view, doc), offset);
  const ref = textReference(view.state.doc, offset);
  if (link?.kind !== "file") {
    if (link) return link;
    if (!ref || doc.virtual) return ref?.kind === "url" ? ref : null;
    return resolvePath(ref, doc.path);
  }
  if (await isFile(link.path)) return link;
  // Servers resolve `/x` against the file system or workspace root; web roots (`public/`) are ours.
  const own = ref && !doc.virtual ? await resolvePath(ref, doc.path) : null;
  if (own) return own;
  return { kind: "missing", from: link.from, to: link.to, value: view.state.sliceDoc(link.from, link.to) };
}
