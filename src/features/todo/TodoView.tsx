/** TODO tool window: "Project" and "Current File" tabs, grouped by file. */
import { useCallback, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import clsx from "clsx";
import { useEditorRegistry } from "@/editor/api";
import { basename, relativeDir, useProject } from "@/platform/project";
import { editorService, useOccurrenceNavigator } from "@/workbench/contributions";
import {
  EmptyState,
  Icon,
  IconButton,
  Menu,
  SourcePreview,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tabs,
  Tree,
  fileIconName,
  type MenuItem,
  type TreeHandle,
  type TreeRowState,
  T,
} from "@/ui";
import { previewText } from "./ipc";
import { activePatterns, countItems, groupTodos, mergeLive, type TodoGroup, type TodoItem } from "./model";
import { scanProject, updateTodoSettings, useTodoSettings, useTodos } from "./store";
import styles from "./TodoView.module.css";

type Tab = "project" | "file";

interface ViewState {
  tab: Tab;
  /** Hidden keywords (filter). */
  hidden: string[];
  collapsed: Set<string>;
  setTab(tab: Tab): void;
  toggleKeyword(k: string): void;
  showAll(): void;
}

export const useTodoView = create<ViewState>((set) => ({
  tab: "project",
  hidden: [],
  collapsed: new Set(),
  setTab: (tab) => set({ tab }),
  toggleKeyword: (k) =>
    set((s) => ({ hidden: s.hidden.includes(k) ? s.hidden.filter((h) => h !== k) : [...s.hidden, k] })),
  showAll: () => set({ hidden: [] }),
}));

// View options (persisted), in the tool window's ⋮ menu. IDEA's defaults:
// preview on, no autoscroll.
const OPTIONS_KEY = "openidea.todo.view.v1";

interface TodoViewOptions {
  preview: boolean;
  autoscroll: boolean;
}

function loadOptions(): Partial<TodoViewOptions> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) ?? "{}") as Partial<TodoViewOptions>;
  } catch {
    return {};
  }
}

export const useTodoViewOptions = create<TodoViewOptions>(() => ({
  preview: true,
  autoscroll: false,
  ...loadOptions(),
}));

useTodoViewOptions.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
});

/** The TODO tool window's ⋮ menu entries. */
export function useTodoHeaderMenu(): MenuItem[] {
  const o = useTodoViewOptions();
  return [
    {
      id: "preview",
      label: "Show Preview",
      checked: o.preview,
      run: () => useTodoViewOptions.setState({ preview: !o.preview }),
    },
    {
      id: "autoscroll",
      label: "Autoscroll to Source",
      checked: o.autoscroll,
      run: () => useTodoViewOptions.setState({ autoscroll: !o.autoscroll }),
    },
  ];
}

type Node = { kind: "file"; key: string; group: TodoGroup } | { kind: "item"; key: string; item: TodoItem };

function keywordFilter(hidden: readonly string[], all: readonly string[]): Set<string> | null {
  return hidden.length ? new Set(all.filter((k) => !hidden.includes(k))) : null;
}

/** Groups for a tab (exported for the badge and tests). */
export function useTodoGroups(tab: Tab): TodoGroup[] {
  const scanned = useTodos((s) => s.scanned);
  const live = useTodos((s) => s.live);
  const hidden = useTodoView((s) => s.hidden);
  const patterns = useTodoSettings((s) => s.patterns);
  const current = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  return useMemo(() => {
    const merged = mergeLive(scanned, live);
    const keywords = keywordFilter(
      hidden,
      patterns.map((p) => p.keyword.trim()),
    );
    return groupTodos(merged, tab === "file" ? { keywords, path: current } : { keywords });
  }, [scanned, live, hidden, patterns, tab, current]);
}

export function useTodoBadge(): number | null {
  const n = countItems(useTodoGroups("project"));
  return n || null;
}

function open(item: TodoItem, focus: boolean) {
  void editorService().openFile(item.path, { selection: { line: item.line, col: item.col }, focus, preview: !focus });
}

function colorFor(keyword: string): string {
  const s = useTodoSettings.getState();
  const k = s.caseSensitive ? keyword : keyword.toLowerCase();
  return (
    s.patterns.find((p) => (s.caseSensitive ? p.keyword.trim() : p.keyword.trim().toLowerCase()) === k)?.color ??
    "var(--info)"
  );
}

function ItemText({ item }: { item: TodoItem }) {
  const kwLen = item.keyword.length;
  const color = colorFor(item.keyword);
  return (
    <span className={styles.text} style={{ color }}>
      <strong className={styles.keyword}>{item.text.slice(0, kwLen)}</strong>
      {item.text.slice(kwLen)}
    </span>
  );
}

export function TodoHeaderActions() {
  const settings = useTodoSettings();
  const hidden = useTodoView((s) => s.hidden);
  const toggleKeyword = useTodoView((s) => s.toggleKeyword);
  const showAll = useTodoView((s) => s.showAll);
  const scanning = useTodos((s) => s.scanning);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const items: MenuItem[] = [
    { id: "all", label: "Show All", checked: hidden.length === 0, run: showAll },
    { kind: "separator" },
    ...activePatterns(settings).map((p) => ({
      id: p.id,
      label: p.keyword,
      checked: !hidden.includes(p.keyword.trim()),
      run: () => toggleKeyword(p.keyword.trim()),
    })),
  ];
  return (
    <>
      <IconButton icon="arrow-up" action="navigate.prevOccurrence" size="small" />
      <IconButton icon="arrow-down" action="navigate.nextOccurrence" size="small" />
      <IconButton
        icon="filter"
        size="small"
        title="Filter TODO Items"
        pressed={hidden.length > 0}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      />
      <Menu open={!!anchor} anchor={anchor} items={items} onClose={() => setAnchor(null)} aria-label="TODO filters" />
      <IconButton
        icon="case"
        size="small"
        title="Match Case"
        pressed={settings.caseSensitive}
        onClick={() => updateTodoSettings({ caseSensitive: !settings.caseSensitive })}
      />
      <IconButton icon="refresh" size="small" title="Refresh" disabled={scanning} onClick={() => void scanProject()} />
    </>
  );
}

/** Scope tabs in the tool window header: "Project" / "Current File". */
export function TodoTabs() {
  const tab = useTodoView((s) => s.tab);
  const setTab = useTodoView((s) => s.setTab);
  const current = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  const projectCount = countItems(useTodoGroups("project"));
  const fileCount = countItems(useTodoGroups("file"));
  return (
    <Tabs
      variant="compact"
      aria-label="TODO scope"
      className={styles.tabs}
      activeId={tab}
      onSelect={(id) => setTab(id as Tab)}
      items={[
        {
          id: "project",
          label: "Project",
          trailing: projectCount ? <span className={styles.tabCount}>{projectCount}</span> : undefined,
        },
        {
          id: "file",
          label: current ? (
            <>
              <T>Current File</T> <span className={styles.tabFile}>{basename(current)}</span>
            </>
          ) : (
            "Current File"
          ),
          text: "Current File",
          trailing: fileCount ? <span className={styles.tabCount}>{fileCount}</span> : undefined,
        },
      ]}
    />
  );
}

export function TodoView() {
  const tab = useTodoView((s) => s.tab);
  const collapsed = useTodoView((s) => s.collapsed);
  const root = useProject((s) => s.project?.root ?? "");
  const current = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  const { scanning, error, limitHit, scannedOnce } = useTodos();
  const groups = useTodoGroups(tab);
  const showPreview = useTodoViewOptions((o) => o.preview);
  const tree = useRef<TreeHandle>(null);
  const [lead, setLead] = useState<Node | null>(null);

  useOccurrenceNavigator("todo", (dir, focus) => {
    const step = tree.current?.selectOccurrence(dir);
    const n = step?.node as Node | undefined;
    if (!step || n?.kind !== "item") return null;
    open(n.item, focus);
    return step;
  });

  const roots = useMemo<Node[]>(() => groups.map((g) => ({ kind: "file", key: g.path, group: g })), [groups]);
  const expanded = useMemo(
    () => new Set(roots.filter((r) => !collapsed.has(r.key)).map((r) => r.key)),
    [roots, collapsed],
  );
  const getChildren = useCallback(
    (n: Node): Node[] | undefined =>
      n.kind === "file"
        ? n.group.items.map((item) => ({ kind: "item", key: `${item.path}\u0000${item.line}:${item.col}`, item }))
        : undefined,
    [],
  );

  const renderNode = (n: Node, state: TreeRowState) => {
    if (n.kind === "file") {
      const name = basename(n.group.path);
      return (
        <span className={styles.row}>
          <Icon name={fileIconName(name)} size={16} className={styles.fileIcon} />
          <span className={clsx(styles.fileName, state.selected && styles.selectedText)}>{name}</span>
          <span className={styles.muted}>{relativeDir(root, n.group.path)}</span>
          <span className={styles.count}>
            {n.group.items.length} item{n.group.items.length === 1 ? "" : "s"}
          </span>
        </span>
      );
    }
    return (
      <span className={styles.row} title={n.item.text}>
        <span className={styles.position}>
          ({n.item.line + 1}, {n.item.col + 1})
        </span>
        <ItemText item={n.item} />
      </span>
    );
  };

  const empty =
    tab === "file" && !current ? (
      <EmptyState icon="todo" title="No file is open" />
    ) : error && tab === "project" ? (
      <EmptyState icon="todo" title="TODO items unavailable">
        {error}
      </EmptyState>
    ) : scanning || (!scannedOnce && tab === "project") ? (
      <div className={styles.loading}>
        <Spinner size={14} /> <T>Scanning for TODO items…</T>
      </div>
    ) : (
      <EmptyState icon="todo" title={tab === "file" ? "No TODO items in this file" : "No TODO items found"} />
    );

  return (
    <div className={styles.view}>
      {tab === "project" && limitHit && (
        <div className={styles.banner}>
          <T>Too many matches; showing the first 10 000.</T>
        </div>
      )}
      <div className={styles.body}>
        <SplitGroup orientation="horizontal" id="todo-preview-split">
          <SplitPanel id="items" minSize={160} className={styles.panel}>
            <Tree<Node>
              handleRef={tree}
              roots={roots}
              getKey={(n) => n.key}
              getLabel={(n) => (n.kind === "file" ? basename(n.group.path) : n.item.text)}
              getChildren={getChildren}
              isExpandable={(n) => n.kind === "file"}
              expanded={expanded}
              onExpandedChange={(_next, node, isExpanded) =>
                useTodoView.setState((s) => {
                  const c = new Set(s.collapsed);
                  if (isExpanded) c.delete(node.key);
                  else c.add(node.key);
                  return { collapsed: c };
                })
              }
              renderNode={renderNode}
              onActivate={(n) => {
                if (n.kind === "item") open(n.item, true);
                else if (n.group.items[0]) open(n.group.items[0], true);
              }}
              onSelectionChange={(_sel, node) => {
                setLead(node);
                // Autoscroll to Source (off by default, as in IDEA).
                if (node?.kind === "item" && useTodoViewOptions.getState().autoscroll) open(node.item, false);
              }}
              activateExpandable={false}
              multiSelect={false}
              speedSearch
              aria-label="TODO items"
              empty={empty}
            />
          </SplitPanel>
          {showPreview && (
            <>
              <SplitHandle />
              <SplitPanel id="preview" minSize={160} defaultSize="45%" className={styles.panel}>
                <TodoPreview node={lead} />
              </SplitPanel>
            </>
          )}
        </SplitGroup>
      </div>
    </div>
  );
}

function TodoPreview({ node }: { node: Node | null }) {
  const item = node?.kind === "item" ? node.item : (node?.group.items[0] ?? null);
  const highlights = item ? [{ line: item.line, ranges: [[item.col, item.col + item.text.length] as const] }] : [];
  return <SourcePreview path={item?.path ?? null} line={item?.line ?? 0} highlights={highlights} load={previewText} />;
}
