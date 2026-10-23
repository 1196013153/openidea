import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import type { SearchQuery } from "@/platform/ipc";
import { previewReplacement } from "./session";
import { loadPreviewText } from "./preview";
import type { PreviewLine } from "./replaceFlow";
import styles from "./parts.module.css";
import { T } from "@/ui";

/** A result line with matches highlighted; in replace mode shows `old → new` inline. */
export function MatchText({
  text,
  ranges,
  active,
  replacement,
  query,
  preserveCase = false,
}: {
  text: string;
  ranges: ReadonlyArray<readonly [number, number]>;
  active?: boolean;
  replacement?: string | null;
  query?: Pick<SearchQuery, "pattern" | "isRegex" | "caseSensitive"> | null;
  preserveCase?: boolean;
}) {
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([s, e], i) => {
    if (s < pos) return;
    if (s > pos) parts.push(text.slice(pos, s));
    const matched = text.slice(s, e);
    if (replacement != null && query) {
      parts.push(
        <del key={`d${i}`} className={styles.removed}>
          {matched}
        </del>,
        <ins key={`i${i}`} className={styles.inserted}>
          {previewReplacement(matched, query, replacement, preserveCase)}
        </ins>,
      );
    } else {
      parts.push(
        <mark key={i} className={clsx(styles.match, active && styles.matchActive)}>
          {matched}
        </mark>,
      );
    }
    pos = e;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return <span className={styles.text}>{parts}</span>;
}

const WINDOW = 300;

export interface PreviewHighlight {
  line: number;
  /** Columns in the real line. */
  ranges: ReadonlyArray<readonly [number, number]>;
}

/** Read-only code view around `line` with line numbers and highlighted matches. */
export function CodePreview({
  path,
  line,
  highlights,
  version = 0,
}: {
  path: string | null;
  line: number;
  highlights: readonly PreviewHighlight[];
  version?: number;
}) {
  const [text, setText] = useState<{ path: string; lines: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const current = text && text.path === path ? text : null;

  useEffect(() => {
    if (!path) return;
    let alive = true;
    // Debounced so arrowing through results doesn't load every file.
    const t = setTimeout(() => {
      loadPreviewText(path).then(
        (t) => {
          if (!alive) return;
          setText({ path, lines: t.split(/\r\n|\r|\n/) });
          setError(null);
        },
        (e) => alive && setError(String((e as Error)?.message ?? e)),
      );
    }, 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [path, version]);

  const start = Math.max(0, line - WINDOW);
  useLayoutEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (el && scrollRef.current) {
      const box = scrollRef.current;
      box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
    }
  }, [current, line]);

  if (!path)
    return (
      <div className={clsx(styles.preview, styles.previewEmpty)}>
        <T>Select a result to preview</T>
      </div>
    );
  if (error && !current) return <div className={clsx(styles.preview, styles.previewEmpty)}>{error}</div>;
  if (!current) return <div className={styles.preview} />;

  const byLine = new Map(highlights.map((h) => [h.line, h.ranges]));
  const end = Math.min(current.lines.length, line + WINDOW);
  const rows: ReactNode[] = [];
  for (let n = start; n < end; n++) {
    const content = current.lines[n] ?? "";
    const ranges = byLine.get(n);
    rows.push(
      <div key={n} data-line={n} className={clsx(styles.codeLine, n === line && styles.currentLine)}>
        <span className={styles.gutter}>{n + 1}</span>
        <span className={styles.code}>
          {ranges ? <MatchText text={content} ranges={ranges} active={n === line} /> : content || " "}
        </span>
      </div>,
    );
  }
  return (
    <div ref={scrollRef} className={styles.preview} role="region" aria-label="Preview">
      <pre className={styles.pre}>{rows}</pre>
    </div>
  );
}

/** Replace › Preview: unified line diff of the replacement around `line`. */
export function ReplaceDiffPreview({ lines, line }: { lines: readonly PreviewLine[] | null; line: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>("[data-focus]");
    if (box && el) box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
  }, [lines, line]);
  if (!lines) return <div className={styles.preview} />;
  const focus = lines.findIndex((l) => l.kind !== "same" && (l.kind === "del" ? l.line >= line : true));
  const from = Math.max(0, focus - WINDOW);
  const shown = lines.slice(from, Math.max(focus, 0) + WINDOW);
  return (
    <div ref={scrollRef} className={styles.preview} role="region" aria-label="Replace preview">
      <pre className={styles.pre}>
        {shown.map((l, i) => (
          <div
            key={from + i}
            data-focus={from + i === focus ? "" : undefined}
            data-kind={l.kind}
            className={clsx(
              styles.codeLine,
              l.kind === "del" && styles.lineDeleted,
              l.kind === "add" && styles.lineAdded,
            )}
          >
            <span className={styles.gutter}>{l.line + 1}</span>
            <span className={styles.sign}>{l.kind === "del" ? "-" : l.kind === "add" ? "+" : " "}</span>
            <span className={styles.code}>{l.text || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
