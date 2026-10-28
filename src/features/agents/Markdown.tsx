/**
 * Agent messages: Markdown → sanitized HTML (marked + DOMPurify). Fenced code is
 * highlighted and gets a Copy button; inline code naming a file of the task opens it.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { highlightInto } from "@/editor/lsp/markdown";
import { iconNode } from "@/editor/lsp/iconMarkup";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { copyText } from "@/ui";
import { editorService } from "@/workbench/contributions";
import { pathLink, type PathLink } from "./conversation";
import styles from "./Session.module.css";

const marked = new Marked({ gfm: true, breaks: true });

export function markdownHtml(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/** Whether a path names an existing file, per path (agents name the same files again and again). */
const existing = new Map<string, Promise<boolean>>();
function fileExists(path: string): Promise<boolean> {
  let known = existing.get(path);
  if (!known) {
    known = call(commands.fsProbe(path)).then(
      () => true,
      () => false,
    );
    existing.set(path, known);
  }
  return known;
}

export function openPathLink(link: PathLink) {
  const selection = link.line === undefined ? undefined : { line: link.line, col: link.col ?? 0 };
  void editorService().openFile(link.path, { selection, focus: true });
}

/** Highlighting, Copy buttons and file links over freshly rendered `root`. */
function enhance(root: HTMLElement, cwd: string): () => void {
  let alive = true;
  root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
    const pre = code.parentElement!;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length) ?? null;
    const text = (code.textContent ?? "").replace(/\n+$/, "");
    code.textContent = text;
    void highlightInto(code, text, lang);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = styles.codeCopy!;
    const label = tx("Copy Code");
    copy.title = label;
    copy.setAttribute("aria-label", label);
    copy.appendChild(iconNode("copy", 14));
    copy.dataset.copy = text;
    pre.appendChild(copy);
  });
  root.querySelectorAll<HTMLElement>("code").forEach((code) => {
    if (code.parentElement?.tagName === "PRE" || code.closest("a")) return;
    const link = pathLink(code.textContent ?? "", cwd);
    if (!link) return;
    void fileExists(link.path).then((exists) => {
      if (!alive || !exists) return;
      code.classList.add(styles.fileLink!);
      code.dataset.path = link.path;
      if (link.line !== undefined) code.dataset.line = String(link.line);
      if (link.col !== undefined) code.dataset.col = String(link.col);
      code.title = tx`Open ${link.path}`;
    });
  });
  return () => {
    alive = false;
  };
}

export function Markdown({ text, cwd }: { text: string; cwd: string }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? enhance(ref.current, cwd) : undefined), [html, cwd]);
  return (
    <div
      ref={ref}
      className={styles.markdown}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const copy = target.closest<HTMLElement>("button[data-copy]");
        if (copy) {
          void copyText(copy.dataset.copy ?? "");
          return;
        }
        const file = target.closest<HTMLElement>("code[data-path]");
        if (file && !window.getSelection()?.toString()) {
          const line = file.dataset.line === undefined ? undefined : Number(file.dataset.line);
          const col = file.dataset.col === undefined ? undefined : Number(file.dataset.col);
          openPathLink({ path: file.dataset.path!, line, col });
          return;
        }
        const a = target.closest("a");
        if (!a) return;
        e.preventDefault();
        if (/^https?:/i.test(a.href)) void openExternalUrl(a.href);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
