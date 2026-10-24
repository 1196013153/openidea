import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { EmptyState, Icon, IconButton, Tree, fileIconName, showContextMenu } from "@/ui";
import { basename, openLocation, relPath } from "../common/open";
import { bookmarkLabel, removeBookmarks, updateBookmarks, useBookmarkPopups, useBookmarks, type Bookmark } from "./store";
import styles from "./BookmarksView.module.css";

type Node =
  | { kind: "list"; key: string; name: string; children: Node[] }
  | { kind: "file"; key: string; path: string; name: string; dir: string; children: Node[] }
  | { kind: "mark"; key: string; bookmark: Bookmark };

const LIST_KEY = "\u0000list";

const markKey = (b: Bookmark) => `b:${b.path}:${b.line}`;

export function groupBookmarks(items: readonly Bookmark[]): Node[] {
  const files = new Map<string, Node & { kind: "file" }>();
  for (const b of items) {
    let f = files.get(b.path);
    if (!f) {
      const rel = relPath(b.path);
      const name = basename(rel);
      f = { kind: "file", key: `f:${b.path}`, path: b.path, name, dir: rel.slice(0, Math.max(0, rel.length - name.length - 1)), children: [] };
      files.set(b.path, f);
    }
    f.children.push({ kind: "mark", key: markKey(b), bookmark: b });
  }
  return [...files.values()];
}

function removeNodes(nodes: Node[]) {
  const marks = new Set<string>();
  const paths = new Set<string>();
  for (const n of nodes) {
    if (n.kind === "list") return updateBookmarks(() => []);
    if (n.kind === "file") paths.add(n.path);
    else marks.add(markKey(n.bookmark));
  }
  updateBookmarks((list) => removeBookmarks(list, (b) => paths.has(b.path) || marks.has(markKey(b))));
}

export function BookmarksView() {
  const items = useBookmarks((s) => s.items);
  const projectRoot = useProject((s) => s.project?.root ?? null);
  const files = useMemo(() => groupBookmarks(items), [items]);
  const roots = useMemo<Node[]>(
    () => [{ kind: "list", key: LIST_KEY, name: projectRoot ? basename(projectRoot) : "Bookmarks", children: files }],
    [files, projectRoot],
  );
  const byKey = useMemo(() => {
    const m = new Map<string, Node>();
    for (const r of files) {
      m.set(r.key, r);
      if (r.kind === "file") r.children.forEach((c) => m.set(c.key, c));
    }
    m.set(LIST_KEY, roots[0]!);
    return m;
  }, [files, roots]);
  const allKeys = useMemo(() => [LIST_KEY, ...files.map((r) => r.key)], [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const expanded = useMemo(() => new Set(allKeys.filter((k) => !collapsed.has(k))), [allKeys, collapsed]);
  const selection = useRef<Set<string>>(new Set());

  if (!items.length) {
    return (
      <EmptyState>
        No bookmarks yet. Toggle a line bookmark with {shortcutLabel("navigate.toggleBookmark") ?? "F3"}
      </EmptyState>
    );
  }

  const open = (n: Node) => {
    if (n.kind === "mark") void openLocation(n.bookmark.path, { line: n.bookmark.line, col: 0 });
    else if (n.kind === "file") void openLocation(n.path);
  };

  const rename = (b: Bookmark) => useBookmarkPopups.setState({ editing: { path: b.path, line: b.line } });

  const onKeyDown = (e: KeyboardEvent) => {
    const nodes = [...selection.current].map((k) => byKey.get(k)).filter((n): n is Node => !!n);
    if (e.key === "F2" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const mark = nodes.length === 1 && nodes[0]!.kind === "mark" ? nodes[0]!.bookmark : null;
      if (!mark) return;
      e.preventDefault();
      e.stopPropagation();
      rename(mark);
      return;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (!nodes.length) return;
    e.preventDefault();
    e.stopPropagation();
    removeNodes(nodes);
  };

  return (
    <div className={styles.root} onKeyDownCapture={onKeyDown}>
      <Tree<Node>
        className={styles.tree}
        aria-label="Bookmarks"
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) => (n.kind === "mark" ? bookmarkLabel(n.bookmark) : n.name)}
        getChildren={(n) => (n.kind === "mark" ? undefined : n.children)}
        isExpandable={(n) => n.kind !== "mark"}
        expanded={expanded}
        onExpandedChange={(next) => setCollapsed(new Set(allKeys.filter((k) => !next.has(k))))}
        onSelectionChange={(next) => {
          selection.current = next;
        }}
        onActivate={open}
        onContextMenu={(node, sel, e) => {
          const targets = sel.size ? [...sel].map((k) => byKey.get(k)).filter((n): n is Node => !!n) : node ? [node] : [];
          if (!targets.length) return;
          e.preventDefault();
          showContextMenu(e, [
            ...(node && node.kind !== "list" ? [{ label: "Jump to Source", run: () => open(node) }] : []),
            ...(node?.kind === "mark" && targets.length === 1
              ? [{ label: "Rename…", shortcut: "F2", run: () => rename(node.bookmark) }]
              : []),
            { kind: "separator" as const },
            { label: targets.length > 1 ? `Delete ${targets.length} Bookmarks` : "Delete Bookmark", danger: true, run: () => removeNodes(targets) },
          ]);
        }}
        renderNode={(n) =>
          n.kind === "list" ? (
            <span className={styles.node}>
              <Icon name="toolwindow-bookmarks" size={16} className={styles.icon} />
              <span className={styles.label}>{n.name}</span>
              <span className={styles.meta}>
                {items.length} bookmark{items.length === 1 ? "" : "s"}
              </span>
            </span>
          ) : n.kind === "file" ? (
            <span className={styles.node}>
              <Icon name={fileIconName(n.name)} size={16} className={styles.icon} />
              <span className={styles.label}>{n.name}</span>
              <span className={styles.meta}>{n.dir}</span>
            </span>
          ) : (
            <span className={styles.node}>
              {n.bookmark.mnemonic ? (
                <span className={styles.mnemonic} aria-label={`Mnemonic ${n.bookmark.mnemonic}`}>
                  {n.bookmark.mnemonic}
                </span>
              ) : (
                <Icon name="bookmark" size={16} className={styles.icon} />
              )}
              {n.bookmark.description ? (
                <>
                  <span className={styles.label}>{n.bookmark.description}</span>
                  <span className={styles.meta}>
                    {basename(n.bookmark.path)}:{n.bookmark.line + 1}
                  </span>
                </>
              ) : (
                <>
                  <span className={styles.label}>
                    {basename(n.bookmark.path)}:{n.bookmark.line + 1}
                  </span>
                  <span className={styles.code}>{n.bookmark.text.trim() || "(empty line)"}</span>
                </>
              )}
            </span>
          )
        }
      />
    </div>
  );
}

export function BookmarksActions() {
  const count = useBookmarks((s) => s.items.length);
  if (!count) return null;
  return <IconButton icon="trash" title="Remove All Bookmarks" size="small" onClick={() => updateBookmarks(() => [])} />;
}
