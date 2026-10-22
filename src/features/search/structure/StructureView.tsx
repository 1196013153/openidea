import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import clsx from "clsx";
import { shortcutLabel } from "@/platform/keymap";
import {
  Dialog,
  EmptyState,
  HighlightedText,
  Icon,
  IconButton,
  List,
  SymbolBadge,
  Tree,
  fileIconName,
  listNavigate,
  type TreeHandle,
} from "@/ui";
import { badgeKind, basename, openLocation } from "../common/open";
import { useTracking } from "../common/tracking";
import { allKeys, bestRow, flattenOutline, keyOutline, sortOutline, symbolPathAt, type FlatOutlineRow, type OutlineNode } from "./outline";
import { useLiveOutline, useOutline, useStructureOptions } from "./store";
import styles from "./StructureView.module.css";

function useOutlineNodes(alphabetical: boolean) {
  const items = useOutline((s) => s.items);
  return useMemo(() => sortOutline(keyOutline(items ?? []), alphabetical), [items, alphabetical]);
}

const navigate = (path: string, node: OutlineNode, focus: boolean) => {
  const p = node.item.selection_range.start;
  void openLocation(path, { line: p.line, col: p.col }, { focus });
};

const useCollapsed = create<{ keys: ReadonlySet<string> }>(() => ({ keys: new Set() }));

/** The file itself, shown as the tree root like IDEA. */
interface FileRoot {
  key: string;
  file: true;
  name: string;
  children: OutlineNode[];
}
type StructNode = OutlineNode | FileRoot;
const FILE_KEY = "\u0000file";
const isFile = (n: StructNode): n is FileRoot => "file" in n;

// ---------------------------------------------------------------------------
// Tool window

export function StructureView() {
  useLiveOutline();
  const path = useOutline((s) => s.path);
  const items = useOutline((s) => s.items);
  const loading = useOutline((s) => s.loading);
  const error = useOutline((s) => s.error);
  const alphabetical = useStructureOptions((s) => s.alphabetical);
  const autoscroll = useStructureOptions((s) => s.autoscroll);
  const caret = useTracking((s) => s.caret);
  const collapsed = useCollapsed((s) => s.keys);
  const nodes = useOutlineNodes(alphabetical);
  const tree = useRef<TreeHandle>(null);
  const revealing = useRef(false);

  const expandable = useMemo(() => [FILE_KEY, ...allKeys(nodes)], [nodes]);
  const expanded = useMemo(() => new Set(expandable.filter((k) => !collapsed.has(k))), [expandable, collapsed]);
  const roots = useMemo<StructNode[]>(
    () => [{ key: FILE_KEY, file: true, name: path ? basename(path) : "", children: nodes }],
    [nodes, path],
  );

  // Autoscroll from source: select the innermost symbol around the caret.
  const caretPath = useMemo(() => {
    if (!autoscroll || !caret || caret.path !== path) return [];
    return symbolPathAt(nodes, { line: caret.line, col: caret.col });
  }, [autoscroll, caret, path, nodes]);
  const caretKey = caretPath[caretPath.length - 1] ?? null;

  useEffect(() => {
    if (!caretKey) return;
    const hidden = caretPath.slice(0, -1).filter((k) => collapsed.has(k));
    if (hidden.length) {
      const next = new Set(collapsed);
      hidden.forEach((k) => next.delete(k));
      useCollapsed.setState({ keys: next });
      return; // re-runs once the ancestors are expanded
    }
    revealing.current = true;
    tree.current?.reveal(caretKey);
    revealing.current = false;
  }, [caretKey, caretPath, collapsed]);

  if (!path) return <EmptyState>No structure to show</EmptyState>;
  if (!items) {
    return error ? (
      <EmptyState title="Structure unavailable">{error}</EmptyState>
    ) : (
      <div className={styles.loading}>{loading ? "Loading…" : null}</div>
    );
  }

  return (
    <div className={styles.root}>
      <StructureToolbar />
      <Tree<StructNode>
        className={styles.tree}
        aria-label="Structure"
        handleRef={tree}
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) => (isFile(n) ? n.name : n.item.name)}
        getChildren={(n) => (n.children.length ? n.children : undefined)}
        isExpandable={(n) => n.children.length > 0}
        expanded={expanded}
        onExpandedChange={(next) => useCollapsed.setState({ keys: new Set(expandable.filter((k) => !next.has(k))) })}
        onSelectionChange={(_next, lead) => {
          if (!revealing.current && lead && !isFile(lead)) navigate(path, lead, false);
        }}
        multiSelect={false}
        activateExpandable
        onActivate={(n) => !isFile(n) && navigate(path, n, true)}
        renderNode={(n, s) =>
          isFile(n) ? (
            <span className={styles.node}>
              <Icon name={fileIconName(n.name)} size={16} className={styles.badge} />
              <HighlightedText className={styles.name} text={n.name} indices={s.matches} tone="strong" />
              {!n.children.length && <span className={styles.detail}>no symbols</span>}
            </span>
          ) : (
            <span className={styles.node}>
              <SymbolBadge kind={badgeKind(n.item.kind)} className={styles.badge} />
              <HighlightedText
                className={styles.name}
                text={n.item.name}
                indices={s.matches}
                tone={s.selected ? "accent" : "strong"}
              />
              {n.item.detail && <span className={styles.detail}>{n.item.detail}</span>}
            </span>
          )
        }
      />
    </div>
  );
}

function StructureToolbar() {
  const alphabetical = useStructureOptions((s) => s.alphabetical);
  const autoscroll = useStructureOptions((s) => s.autoscroll);
  const items = useOutline((s) => s.items);
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Structure actions">
      <IconButton
        icon="sort"
        title="Sort Alphabetically"
        size="small"
        iconSize={16}
        pressed={alphabetical}
        onClick={() => useStructureOptions.setState({ alphabetical: !alphabetical })}
      />
      <span className={styles.sep} />
      <IconButton
        icon="locate"
        title="Autoscroll from Source"
        size="small"
        iconSize={16}
        pressed={autoscroll}
        onClick={() => useStructureOptions.setState({ autoscroll: !autoscroll })}
      />
      <span className={styles.grow} />
      <IconButton
        icon="expand-all"
        title="Expand All"
        size="small"
        iconSize={16}
        onClick={() => useCollapsed.setState({ keys: new Set() })}
      />
      <IconButton
        icon="collapse-all"
        title="Collapse All"
        size="small"
        iconSize={16}
        onClick={() => useCollapsed.setState({ keys: new Set(allKeys(keyOutline(items ?? []))) })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ⌘F12 File Structure popup

export const useFileStructurePopup = create<{ open: boolean }>(() => ({ open: false }));

export function FileStructureOverlay() {
  const open = useFileStructurePopup((s) => s.open);
  return open ? <FileStructureDialog /> : null;
}

const POPUP_ROW = 22;

function FileStructureDialog() {
  useLiveOutline();
  const path = useOutline((s) => s.path);
  const items = useOutline((s) => s.items);
  const loading = useOutline((s) => s.loading);
  const alphabetical = useStructureOptions((s) => s.alphabetical);
  const nodes = useOutlineNodes(alphabetical);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<number | null>(null);
  const caret = useMemo(() => useTracking.getState().caret, []);
  const rows = useMemo(() => flattenOutline(nodes, query), [nodes, query]);

  const initial = useMemo(() => {
    if (query) return Math.max(0, bestRow(rows));
    if (!caret || caret.path !== path) return 0;
    const key = symbolPathAt(nodes, { line: caret.line, col: caret.col }).pop();
    return Math.max(0, rows.findIndex((r) => r.node.key === key));
  }, [rows, nodes, query, caret, path]);
  const active = rows.length ? Math.min(index ?? initial, rows.length - 1) : -1;

  const close = () => useFileStructurePopup.setState({ open: false });
  const choose = (row: FlatOutlineRow | undefined) => {
    if (!row || !path) return;
    close();
    setTimeout(() => navigate(path, row.node, true), 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      choose(rows[active]);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) return;
    e.preventDefault();
    const next = listNavigate(e.key, { items: rows, active, wrap: true });
    if (next !== null) setIndex(next);
  };

  const height = Math.min(420, Math.max(1, rows.length) * POPUP_ROW + 8);
  return (
    <Dialog
      open
      onClose={close}
      width={460}
      position="top"
      transparentBackdrop
      aria-label="File Structure"
      title={
        <span className={styles.popupTitle}>
          {path ? basename(path) : "File Structure"}
          <span className={styles.popupHint}>{shortcutLabel("navigate.fileStructure")}</span>
        </span>
      }
    >
      <div className={styles.filterRow}>
        <input
          data-autofocus
          className={styles.filter}
          value={query}
          placeholder={path ? "Type to filter symbols" : "No active editor"}
          aria-label="Filter symbols"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(null);
          }}
          onKeyDown={onKeyDown}
        />
        <IconButton
          icon="sort"
          title="Sort Alphabetically"
          size="small"
          pressed={alphabetical}
          onClick={() => useStructureOptions.setState({ alphabetical: !alphabetical })}
        />
      </div>
      <div className={styles.popupList} style={{ height }}>
        <List<FlatOutlineRow>
          items={rows}
          getKey={(r) => r.node.key}
          activeIndex={active}
          onActiveChange={setIndex}
          onActivate={(r) => choose(r)}
          focusable={false}
          rowHeight={POPUP_ROW}
          aria-label="Symbols"
          empty={<span>{!path ? "Open a file first" : loading && !items ? "Loading…" : "No symbols"}</span>}
          renderItem={(r, s) => (
            <span className={clsx(styles.node, !r.matched && styles.ancestor)} style={{ paddingLeft: r.depth * 14 }}>
              <SymbolBadge kind={badgeKind(r.node.item.kind)} className={styles.badge} />
              <HighlightedText className={styles.name} text={r.node.item.name} indices={r.indices} tone={s.active ? "accent" : "strong"} />
              {r.node.item.detail && <span className={styles.detail}>{r.node.item.detail}</span>}
            </span>
          )}
        />
      </div>
    </Dialog>
  );
}
