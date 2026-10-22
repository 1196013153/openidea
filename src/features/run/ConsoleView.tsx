import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { showContextMenu } from "@/ui";
import type { ConsoleLine, ConsoleModel, SpanStyle } from "./console";
import { findOutputLinks, type OutputLink } from "./links";
import { openTarget, openUrl } from "./navigate";
import { segmentLine } from "./segments";
import styles from "./Run.module.css";

const ROW = 20;

function spanStyle(s: SpanStyle): CSSProperties | undefined {
  if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline && !s.strike) return undefined;
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ");
  return {
    color: s.fg,
    background: s.bg,
    fontWeight: s.bold ? 600 : undefined,
    opacity: s.dim ? 0.6 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: deco || undefined,
  };
}

const Line = memo(
  function Line({ line, cwd }: { line: ConsoleLine; length: number; cwd: string }) {
    // Not memoised: the open (last) line mutates in place; `memo` below re-renders on length changes only.
    const segments = segmentLine(line.spans, line.kind === "system" ? [] : findOutputLinks(line.text));
    const activate = (e: MouseEvent, link: OutputLink) => {
      e.preventDefault();
      if (window.getSelection()?.toString()) return;
      if (link.kind === "url") void openUrl(link.url);
      else void openTarget(link.target, cwd);
    };
    if (segments.length === 0) return <>{"​"}</>;
    return (
      <>
        {segments.map((seg, i) =>
          seg.link ? (
            <a
              key={i}
              href={seg.link.kind === "url" ? seg.link.url : undefined}
              className={styles.link}
              style={spanStyle(seg.style)}
              onClick={(e) => activate(e, seg.link!)}
              role="link"
              tabIndex={-1}
            >
              {seg.text}
            </a>
          ) : (
            <span key={i} style={spanStyle(seg.style)}>
              {seg.text}
            </span>
          ),
        )}
      </>
    );
  },
  (a, b) => a.line === b.line && a.length === b.length && a.cwd === b.cwd,
);

/** A visible console row: one line, or a fold of consecutive lines (Settings › Console). */
export type DisplayRow = { kind: "line"; index: number } | { kind: "fold"; start: number; count: number; id: number };

/**
 * Folds runs of at least two consecutive output lines that contain one of
 * `patterns`; runs whose first line id is in `expanded` stay open.
 */
export function foldRows(lines: readonly ConsoleLine[], patterns: readonly string[], expanded: ReadonlySet<number>): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const matches = (l: ConsoleLine) => l.kind !== "system" && patterns.some((p) => l.text.includes(p));
  for (let i = 0; i < lines.length; ) {
    if (patterns.length && matches(lines[i]!)) {
      let j = i + 1;
      while (j < lines.length && matches(lines[j]!)) j++;
      const id = lines[i]!.id;
      if (j - i >= 2 && !expanded.has(id)) {
        rows.push({ kind: "fold", start: i, count: j - i, id });
        i = j;
        continue;
      }
      for (; i < j; i++) rows.push({ kind: "line", index: i });
      continue;
    }
    rows.push({ kind: "line", index: i });
    i++;
  }
  return rows;
}

export interface ConsoleViewProps {
  model: ConsoleModel;
  version: number;
  softWrap: boolean;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  /** Directory relative paths in the output resolve against. */
  cwd: string;
  onClear?: () => void;
  "aria-label"?: string;
}

export function ConsoleView({ model, version, softWrap, follow, onFollowChange, cwd, onClear, ...aria }: ConsoleViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = model.lines;
  const patterns = useWorkflowSettings((s) => s.console.foldPatterns);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` marks in-place appends to `lines`
  const rows = useMemo(() => foldRows(lines, patterns, expanded), [lines, version, patterns, expanded]);
  const count = rows.length;
  const programmatic = useRef(false);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 30,
    getItemKey: (i) => {
      const r = rows[i];
      if (!r) return i;
      return r.kind === "fold" ? `f${r.id}` : (lines[r.index]?.id ?? i);
    },
  });

  // Soft wrap changes row heights; re-measure everything.
  useEffect(() => {
    virtualizer.measure();
  }, [softWrap, virtualizer]);

  useLayoutEffect(() => {
    if (!follow || count === 0) return;
    programmatic.current = true;
    virtualizer.scrollToIndex(count - 1, { align: "end" });
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => (programmatic.current = false));
  }, [version, count, follow, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || programmatic.current) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW;
    if (atBottom !== follow) onFollowChange(atBottom);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const selection = window.getSelection()?.toString() ?? "";
    showContextMenu(e, [
      {
        label: "Copy",
        icon: "copy",
        shortcut: "⌘C",
        disabled: !selection,
        run: () => void navigator.clipboard?.writeText(selection).catch(() => undefined),
      },
      { label: "Copy All", run: () => void navigator.clipboard?.writeText(model.text()).catch(() => undefined) },
      { kind: "separator" },
      { label: "Clear All", icon: "trash", disabled: !onClear, run: () => onClear?.() },
    ]);
  };

  const items = virtualizer.getVirtualItems();
  return (
    <div
      ref={scrollRef}
      className={clsx(styles.console, softWrap && styles.wrap)}
      role="log"
      aria-live="off"
      aria-label={aria["aria-label"] ?? "Console"}
      tabIndex={0}
      onScroll={onScroll}
      onContextMenu={onContextMenu}
      data-autofocus=""
    >
      <div className={styles.consoleInner} style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          if (row.kind === "fold") {
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={softWrap ? virtualizer.measureElement : undefined}
                className={styles.line}
                style={{ transform: `translateY(${item.start}px)`, height: softWrap ? undefined : ROW }}
              >
                <button
                  type="button"
                  className={styles.fold}
                  title="Expand folded lines"
                  onClick={() => setExpanded((s) => new Set(s).add(row.id))}
                >
                  {`<${row.count} internal line${row.count === 1 ? "" : "s"}>`}
                </button>
              </div>
            );
          }
          const line = lines[row.index];
          if (!line) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={softWrap ? virtualizer.measureElement : undefined}
              className={clsx(styles.line, styles[line.kind])}
              style={{ transform: `translateY(${item.start}px)`, height: softWrap ? undefined : ROW }}
            >
              <Line line={line} length={line.text.length} cwd={cwd} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
