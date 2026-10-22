/**
 * Markdown (hover, documentation, signature docs) → sanitized DOM. Fenced
 * code blocks are highlighted with the matching Lezer grammar (falling back
 * to the editor's language), using `tok-*` classes styled in `theme.ts`.
 *
 * The Markdown parser (marked + DOMPurify, ~40 KB gzip) loads on first use and
 * is prefetched when the app goes idle; until then markup shows as plain text.
 */
import { useMemo, useSyncExternalStore } from "react";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import type { Markup } from "@/bindings";
import { maybeEditorService } from "@/workbench/contributions";
import { isTauri } from "@/platform/ipc";
import { isVirtualUri } from "@/platform/virtualDocs";

type Parser = typeof import("./markdownParser");

let parser: Parser | null = null;
let loading: Promise<Parser> | null = null;
const readyListeners = new Set<() => void>();

export function loadMarkdown(): Promise<Parser> {
  return (loading ??= import("./markdownParser").then((m) => {
    parser = m;
    readyListeners.forEach((l) => l());
    return m;
  }));
}

/** Loads the parser once the app is idle, so the first hover does not wait for it. */
export function prefetchMarkdown() {
  const load = () => void loadMarkdown().catch(() => {});
  if (typeof requestIdleCallback === "function") requestIdleCallback(load, { timeout: 5000 });
  else setTimeout(load, 2000);
}

function subscribeReady(cb: () => void) {
  readyListeners.add(cb);
  if (!parser) void loadMarkdown().catch(() => {});
  return () => void readyListeners.delete(cb);
}

/** `markupToHtml` for React views: re-renders with the Markdown once the parser has loaded. */
export function useMarkupHtml(m: Markup): string {
  const ready = useSyncExternalStore(subscribeReady, () => parser !== null);
  const { kind, value } = m;
  return useMemo(() => (ready ? markupToHtml({ kind, value }) : plainHtml(value)), [ready, kind, value]);
}

function plainHtml(value: string): string {
  return `<p class="cm-lsp-plain">${escapeHtml(value)}</p>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Sanitized HTML; plain text while the Markdown parser is still loading. */
export function markupToHtml(m: Markup): string {
  if (m.kind === "markdown" && parser) return parser.markdownToSafeHtml(m.value);
  if (m.kind === "markdown") void loadMarkdown().catch(() => {});
  return plainHtml(m.value);
}

export function isEmptyMarkup(m: Markup | null | undefined): boolean {
  return !m || !m.value.trim();
}

const langCache = new Map<string, LanguageDescription | null>();

function findLanguage(name: string): LanguageDescription | null {
  const key = name.toLowerCase();
  if (!langCache.has(key)) langCache.set(key, LanguageDescription.matchLanguageName(languages, key, true));
  return langCache.get(key) ?? null;
}

export function languageForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return LanguageDescription.matchFilename(languages, name)?.name ?? null;
}

/** Replaces `el`'s text with highlighted spans (no-op when the language is unknown). */
export async function highlightInto(el: HTMLElement, text: string, language: string | null): Promise<void> {
  const desc = language ? findLanguage(language) : null;
  if (!desc) return;
  try {
    const support = desc.support ?? (await desc.load());
    const tree = support.language.parser.parse(text);
    const frag = document.createDocumentFragment();
    highlightCode(
      text,
      tree,
      classHighlighter,
      (t, cls) => {
        if (!cls) frag.appendChild(document.createTextNode(t));
        else {
          const span = document.createElement("span");
          span.className = cls;
          span.textContent = t;
          frag.appendChild(span);
        }
      },
      () => frag.appendChild(document.createTextNode("\n")),
    );
    el.replaceChildren(frag);
  } catch {
    // Grammar failed to load: keep the plain text.
  }
}

function highlightBlocks(root: HTMLElement, fallback: string | null) {
  root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
    const cls = [...code.classList].find((c) => c.startsWith("language-"));
    const lang = cls ? cls.slice("language-".length) : fallback;
    const text = (code.textContent ?? "").replace(/\n+$/, "");
    code.textContent = text;
    void highlightInto(code, text, lang);
  });
}

function onLinkClick(e: MouseEvent) {
  const a = (e.target as Element | null)?.closest?.("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("file://")) {
    const url = new URL(href);
    const m = /^#?L?(\d+)(?:[,:](\d+))?/.exec(url.hash.slice(1));
    const selection = m ? { line: Math.max(0, Number(m[1]) - 1), col: m[2] ? Math.max(0, Number(m[2]) - 1) : 0 } : undefined;
    void maybeEditorService()?.openFile(decodeURIComponent(url.pathname), { selection, focus: true });
  } else if (isVirtualUri(href) && !/^https?:/i.test(href) && !/^mailto:/i.test(href)) {
    // Library class links (jdtls hover: `jdt://contents/…#L42`).
    const hash = href.indexOf("#");
    const m = hash >= 0 ? /^L?(\d+)/.exec(href.slice(hash + 1)) : null;
    const selection = m ? { line: Math.max(0, Number(m[1]) - 1), col: 0 } : undefined;
    void maybeEditorService()?.openFile(hash >= 0 ? href.slice(0, hash) : href, { selection, focus: true });
  } else if (/^https?:\/\//.test(href) && isTauri()) {
    void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(href)).catch(() => {});
  }
}

/** Renders markup into a `.cm-lsp-markdown` element. */
export function renderMarkup(m: Markup, fallbackLanguage: string | null = null): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-markdown";
  dom.innerHTML = markupToHtml(m);
  highlightBlocks(dom, fallbackLanguage);
  if (m.kind === "markdown" && !parser) {
    void loadMarkdown()
      .then(() => {
        dom.innerHTML = markupToHtml(m);
        highlightBlocks(dom, fallbackLanguage);
      })
      .catch(() => {});
  }
  dom.addEventListener("click", onLinkClick);
  return dom;
}

/** Renders a code snippet (e.g. a signature or definition) as highlighted mono text. */
export function renderCode(text: string, language: string | null, className = "cm-lsp-code"): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = className;
  const code = document.createElement("code");
  code.textContent = text;
  pre.appendChild(code);
  void highlightInto(code, text, language);
  return pre;
}
