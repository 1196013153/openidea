import { useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import type { FileMatches } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Spinner,
  Tabs,
  Tree,
  fileIconName,
  showContextMenu,
  type TreeRowState,
  T,
} from "@/ui";
import { notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { basename, openLocation, relDir } from "../common/open";
import { MatchText } from "./parts";
import {
  NO_MARKS,
  confirmText,
  countUsages,
  groupState,
  loadReplacePreview,
  pendingUsages,
  replaceTargets,
  startReplace,
  summaryText,
  toggleExcluded,
  type ReplaceMarks,
  type ReplaceProgress,
  type ReplaceRun,
  type UsageGroup,
  type Usage,
} from "./replaceFlow";
import { closeFindTab, rerunFindTab, stopFindTab, useFindWindow, type FindTab } from "./windowStore";
import styles from "./FindToolWindow.module.css";

type Node =
  | { kind: "dir"; key: string; label: string; count: number; children: Node[] }
  | { kind: "file"; key: string; path: string; name: string; count: number; children: Node[] }
  | {
      kind: "match";
      key: string;
      path: string;
      line: number;
      col: number;
      endCol: number;
      text: string;
      ranges: Array<[number, number]>;
      starts: Array<{ line: number; col: number }>;
    };

/** Groups streamed file matches by directory → file → line (IDEA "Group by directory"). */
export function buildFindTree(files: readonly FileMatches[]): Node[] {
  const dirs = new Map<string, Node & { kind: "dir" }>();
  for (const f of files) {
    const dir = relDir(f.relPath);
    let d = dirs.get(dir);
    if (!d) {
      d = { kind: "dir", key: `d:${dir}`, label: dir || "/", count: 0, children: [] };
      dirs.set(dir, d);
    }
    const children: Node[] = f.matches.map((m) => {
      const lead = m.text.length - m.text.trimStart().length;
      const text = m.text.slice(lead).trimEnd();
      const first = m.ranges[0] ?? [0, 0];
      return {
        kind: "match",
        key: `m:${f.path}:${m.line}`,
        path: f.path,
        line: m.line,
        col: first[0] + m.textOffset,
        endCol: first[1] + m.textOffset,
        text,
        ranges: m.ranges
          .map(([s, e]) => [Math.max(0, s - lead), Math.min(text.length, e - lead)] as [number, number])
          .filter(([s, e]) => e > s),
        starts: m.ranges.map(([s]) => ({ line: m.line, col: s + m.textOffset })),
      };
    });
    d.children.push({
      kind: "file",
      key: `f:${f.path}`,
      path: f.path,
      name: basename(f.relPath),
      count: f.matches.length,
      children,
    });
    d.count += f.matches.length;
  }
  return [...dirs.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The usages under a node (itself for a match). */
export function nodeGroups(node: Node): UsageGroup[] {
  if (node.kind === "match") return [{ key: node.key, path: node.path, starts: node.starts }];
  return node.children.flatMap(nodeGroups);
}

/** Excluded (⌫) / replaced usages per Find tab. */
const useMarks = create<{ byTab: Record<number, ReplaceMarks> }>(() => ({ byTab: {} }));
const setMarks = (tab: number, marks: ReplaceMarks) =>
  useMarks.setState((s) => ({ byTab: { ...s.byTab, [tab]: marks } }));

const useCollapsed = create<{ byTab: Record<number, ReadonlySet<string>> }>(() => ({ byTab: {} }));
const setCollapsed = (tab: number, keys: ReadonlySet<string>) =>
  useCollapsed.setState((s) => ({ byTab: { ...s.byTab, [tab]: keys } }));

function allExpandableKeys(nodes: readonly Node[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.kind === "match") continue;
    out.add(n.key);
    allExpandableKeys(n.children, out);
  }
  return out;
}

/** Search tabs in the tool window header. */
export function FindTabs() {
  const tabs = useFindWindow((s) => s.tabs);
  const activeId = useFindWindow((s) => s.active);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];
  if (!tab) return null;
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      aria-label="Searches"
      items={tabs.map((t) => ({ id: String(t.id), label: t.title, closable: true }))}
      activeId={String(tab.id)}
      onSelect={(id) => useFindWindow.setState({ active: Number(id) })}
      onClose={(id) => closeFindTab(Number(id))}
    />
  );
}

export function FindToolWindow() {
  const tabs = useFindWindow((s) => s.tabs);
  const activeId = useFindWindow((s) => s.active);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];
  if (!tab) {
    return (
      <EmptyState title="No search results" icon="search">
        Use Find in Files ({shortcutLabel("find.inPath") ?? "⇧⌘F"}) and choose “Open in Find Window”.
      </EmptyState>
    );
  }
  return (
    <div className={styles.root}>
      <FindTabView key={tab.id} tab={tab} />
    </div>
  );
}

function FindTabView({ tab }: { tab: FindTab }) {
  const roots = useMemo(() => buildFindTree(tab.state.files), [tab.state.files]);
  const collapsed = useCollapsed((s) => s.byTab[tab.id]);
  const expanded = useMemo(() => {
    const all = allExpandableKeys(roots);
    if (collapsed) for (const k of collapsed) all.delete(k);
    return all;
  }, [roots, collapsed]);
  const st = tab.state;
  const marks = useMarks((m) => m.byTab[tab.id]) ?? NO_MARKS;
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<ReplaceRun | null>(null);
  const [progress, setProgress] = useState<ReplaceProgress | null>(null);
  const busy = !!running;
  const allGroups = useMemo(() => roots.flatMap(nodeGroups), [roots]);
  const byKey = useMemo(() => {
    const map = new Map<string, Node>();
    const walk = (list: readonly Node[]) =>
      list.forEach((n) => {
        map.set(n.key, n);
        if (n.kind !== "match") walk(n.children);
      });
    walk(roots);
    return map;
  }, [roots]);
  const selectedGroups = () => [...selection].flatMap((k) => (byKey.get(k) ? nodeGroups(byKey.get(k)!) : []));

  const exclude = () => {
    const groups = selectedGroups();
    if (groups.length) setMarks(tab.id, toggleExcluded(marks, groups));
  };

  const replace = async (usages: Usage[]) => {
    if (tab.replacement === null || !usages.length || running) return;
    const run = startReplace(
      {
        query: tab.query,
        replacement: tab.replacement,
        preserveCase: !!tab.preserveCase,
        targets: replaceTargets(usages),
      },
      setProgress,
    );
    setRunning(run);
    try {
      const summary = await run.result;
      notifications().notify({
        group: "search",
        level: summary.failed ? "warning" : "info",
        title: summaryText(summary),
        key: "search.replace",
      });
      // Replaced usages disappear from the view, as in IDEA; exclusions are kept.
      rerunFindTab(tab.id);
    } catch (e) {
      notifications().notify({
        group: "search",
        level: "error",
        title: "Replace failed",
        body: String((e as Error)?.message ?? e),
      });
    } finally {
      setRunning(null);
      setProgress(null);
    }
  };

  const preview = async () => {
    if (tab.replacement === null) return;
    const groups = selectedGroups();
    const path = groups[0]?.path;
    if (!path) return;
    const usages = pendingUsages(
      groups.filter((g) => g.path === path),
      marks,
    );
    try {
      const p = await loadReplacePreview(tab.query, tab.replacement, !!tab.preserveCase, path, usages);
      await executeAction("diff.compareTexts", {
        path,
        title: `Replace Preview`,
        left: { text: p.before, label: "Original" },
        right: { text: p.after, label: "After Replace" },
        line: usages[0]?.line,
      });
    } catch (e) {
      notifications().notify({
        group: "search",
        level: "error",
        title: "Preview failed",
        body: String((e as Error)?.message ?? e),
      });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      exclude();
    }
  };

  const replaceMode = tab.replacement !== null;
  const allPending = pendingUsages(allGroups, marks);
  const confirmReplaceAll = async () => {
    const ok = await confirm({
      title: "Replace All",
      ok: "Replace",
      message: (
        <>
          {confirmText(countUsages(allPending), tab.query.pattern, tab.replacement ?? "")}
          {marks.excluded.size > 0 && (
            <>
              {" "}
              <T>Excluded usages are skipped.</T>
            </>
          )}
        </>
      ),
    });
    if (ok) void replace(allPending);
  };
  const selectedPending = pendingUsages(selectedGroups(), marks);

  return (
    <div className={styles.body} onKeyDown={onKeyDown}>
      <div className={styles.summary}>
        {(st.status === "searching" || busy) && <Spinner size={12} />}
        <span className={styles.title}>{tab.title}</span>
        <span className={styles.count}>
          {st.status === "invalid" || st.status === "error"
            ? (st.error ?? "Search failed")
            : progress
              ? `Replacing… ${progress.done}/${progress.total} files`
              : `${st.matchCount}${st.summary?.limitHit ? "+" : ""} matches in ${st.files.length} files${
                  marks.excluded.size ? ` · ${marks.excluded.size} excluded` : ""
                }`}
        </span>
        <span className={styles.spacer} />
        <Button size="small" variant="ghost" disabled={!selection.size} onClick={exclude} title="Exclude / include (⌫)">
          <T>Exclude</T>
        </Button>
        {replaceMode && (
          <>
            {running && (
              <Button size="small" onClick={() => running.cancel()}>
                <T>Stop</T>
              </Button>
            )}
            <Button size="small" variant="ghost" disabled={!selection.size || busy} onClick={() => void preview()}>
              <T>Preview</T>
            </Button>
            <Button
              size="small"
              disabled={!selectedPending.length || busy}
              onClick={() => void replace(selectedPending)}
            >
              <T>Replace Selected</T>
            </Button>
            <Button
              size="small"
              disabled={busy || !allPending.length || st.status === "searching"}
              onClick={() => void confirmReplaceAll()}
            >
              <T>Replace All</T>
            </Button>
          </>
        )}
      </div>
      <Tree<Node>
        className={styles.tree}
        aria-label="Find results"
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) => (n.kind === "dir" ? n.label : n.kind === "file" ? n.name : n.text)}
        getChildren={(n) => (n.kind === "match" ? undefined : n.children)}
        isExpandable={(n) => n.kind !== "match"}
        expanded={expanded}
        onExpandedChange={(next) => {
          const all = allExpandableKeys(roots);
          setCollapsed(tab.id, new Set([...all].filter((k) => !next.has(k))));
        }}
        selected={selection}
        onSelectionChange={(next) => setSelection(next)}
        multiSelect
        onActivate={(n) => {
          if (n.kind === "match")
            void openLocation(n.path, { line: n.line, col: n.col, endLine: n.line, endCol: n.endCol }, { focus: true });
          else if (n.kind === "file") void openLocation(n.path);
        }}
        onContextMenu={(_n, sel, e) => {
          const groups = [...sel].flatMap((k) => (byKey.get(k) ? nodeGroups(byKey.get(k)!) : []));
          const excludedAll = groups.length > 0 && groups.every((g) => groupState(g, marks) === "excluded");
          showContextMenu(e, [
            {
              id: "exclude",
              label: excludedAll ? "Include" : "Exclude",
              shortcut: "⌫",
              disabled: !groups.length,
              run: exclude,
            },
            ...(replaceMode
              ? [
                  {
                    id: "replace",
                    label: "Replace Selected",
                    disabled: busy || !pendingUsages(groups, marks).length,
                    run: () => void replace(pendingUsages(groups, marks)),
                  },
                  {
                    id: "preview",
                    label: "Preview Replacement",
                    disabled: busy || !groups.length,
                    run: () => void preview(),
                  },
                ]
              : []),
          ]);
        }}
        activateExpandable={false}
        renderNode={(n, s) => <FindNode node={n} state={s} tab={tab} marks={marks} />}
        empty={
          <span className={styles.empty}>
            {st.status === "searching" || st.status === "validating" ? "Searching…" : "No matches"}
          </span>
        }
      />
    </div>
  );
}

function FindNode({ node, state, tab, marks }: { node: Node; state: TreeRowState; tab: FindTab; marks: ReplaceMarks }) {
  const excluded = nodeGroups(node).every((g) => groupState(g, marks) === "excluded");
  return (
    <span className={clsx(styles.nodeWrap, excluded && styles.excluded)}>
      <FindNodeContent node={node} state={state} tab={tab} />
    </span>
  );
}

function FindNodeContent({ node, state, tab }: { node: Node; state: TreeRowState; tab: FindTab }) {
  switch (node.kind) {
    case "dir":
      return (
        <span className={styles.node}>
          <Icon name={state.expanded ? "folder-open" : "folder"} size={14} className={styles.icon} />
          <span className={styles.label}>{node.label}</span>
          <span className={styles.meta}>
            {node.count} {node.count === 1 ? "match" : "matches"}
          </span>
        </span>
      );
    case "file":
      return (
        <span className={styles.node}>
          <Icon name={fileIconName(node.name)} size={14} className={styles.icon} />
          <span className={styles.label}>{node.name}</span>
          <span className={styles.meta}>{node.count}</span>
        </span>
      );
    case "match":
      return (
        <span className={styles.node}>
          <span className={styles.lineNo}>{node.line + 1}</span>
          <span className={styles.code}>
            <MatchText
              text={node.text}
              ranges={node.ranges}
              active={state.selected}
              replacement={tab.replacement}
              query={tab.query}
              preserveCase={!!tab.preserveCase}
            />
          </span>
        </span>
      );
  }
}

/** Header controls of the Find tool window. */
export function FindToolWindowActions() {
  const tabs = useFindWindow((s) => s.tabs);
  const activeId = useFindWindow((s) => s.active);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];
  if (!tab) return null;
  const searching = tab.state.status === "searching";
  return (
    <>
      {searching ? (
        <IconButton icon="stop" title="Stop" size="small" onClick={() => stopFindTab(tab.id)} />
      ) : (
        <IconButton icon="refresh" title="Rerun" size="small" onClick={() => rerunFindTab(tab.id)} />
      )}
      <IconButton icon="expand-all" title="Expand All" size="small" onClick={() => setCollapsed(tab.id, new Set())} />
      <IconButton
        icon="collapse-all"
        title="Collapse All"
        size="small"
        onClick={() => setCollapsed(tab.id, allExpandableKeys(buildFindTree(tab.state.files)))}
      />
      <IconButton icon="close" title="Close Tab" size="small" onClick={() => closeFindTab(tab.id)} />
    </>
  );
}
