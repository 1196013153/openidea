/** "hierarchy" tool window: call hierarchy (⌃⌥H) and type hierarchy (⌃H). */
import { useCallback, useMemo } from "react";
import { basename, relativePath, useProject } from "@/platform/project";
import { EmptyState, IconButton, Spinner, SymbolBadge, Tabs, Tree, badgeKind, type TreeRowState } from "@/ui";
import { openLocation } from "./ipc";
import {
  ROOT_ID,
  directionLabel,
  loadChildren,
  refreshHierarchy,
  setDirection,
  useHierarchy,
  type HierarchyNode,
} from "./hierarchy";
import styles from "./HierarchyView.module.css";

type Node = { kind: "root"; id: string } | { kind: "item"; id: string; node: HierarchyNode };

/** Tool window header: `Callers of foo` content tab. */
export function HierarchyTabs() {
  const mode = useHierarchy((s) => s.mode);
  const direction = useHierarchy((s) => s.direction);
  const root = useHierarchy((s) => s.root);
  if (!root) return null;
  const label = `${directionLabel(mode, direction)} of ${root.name}`;
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      aria-label="Hierarchies"
      items={[{ id: "current", label }]}
      activeId="current"
      onSelect={() => undefined}
    />
  );
}

function HierarchyToolbar() {
  const mode = useHierarchy((s) => s.mode);
  const direction = useHierarchy((s) => s.direction);
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Hierarchy actions">
      <IconButton
        icon="arrow-up"
        size="small"
        iconSize={16}
        title={`${directionLabel(mode, "incoming")} Hierarchy`}
        pressed={direction === "incoming"}
        onClick={() => setDirection("incoming")}
      />
      <IconButton
        icon="arrow-down"
        size="small"
        iconSize={16}
        title={`${directionLabel(mode, "outgoing")} Hierarchy`}
        pressed={direction === "outgoing"}
        onClick={() => setDirection("outgoing")}
      />
      <span className={styles.sep} />
      <IconButton icon="refresh" size="small" iconSize={16} title="Refresh" onClick={refreshHierarchy} />
    </div>
  );
}

export function HierarchyView() {
  const { mode, direction, root, children, failed, loading, generation } = useHierarchy();
  const projectRoot = useProject((s) => s.project?.root ?? "");
  const roots = useMemo<Node[]>(() => (root ? [{ kind: "root", id: ROOT_ID }] : []), [root]);

  const getChildren = useCallback(
    (n: Node): Node[] | undefined =>
      children.get(n.id)?.map((c) => ({ kind: "item", id: c.id, node: c }) as Node),
    [children],
  );
  const isExpandable = useCallback(
    (n: Node) => {
      const loaded = children.get(n.id);
      return loaded === undefined || loaded.length > 0;
    },
    [children],
  );

  if (!root)
    return (
      <EmptyState>Use Call Hierarchy (⌃⌥H) or Type Hierarchy (⌃H) on a symbol to see its hierarchy here</EmptyState>
    );

  const renderNode = (n: Node, _state: TreeRowState) => {
    if (n.kind === "root") {
      return (
        <span className={styles.row}>
          <SymbolBadge kind={mode === "call" ? "function" : "class"} />
          <span className={styles.name}>{root.name}</span>
          <span className={styles.muted}>
            {basename(root.path)}:{root.line + 1}
          </span>
          {loading && <Spinner size={12} />}
          {failed.has(ROOT_ID) && <span className={styles.error}>failed to load</span>}
          {!loading && !failed.has(ROOT_ID) && children.get(ROOT_ID)?.length === 0 && (
            <span className={styles.muted}>— no {directionLabel(mode, direction).toLowerCase()} found</span>
          )}
        </span>
      );
    }
    const { item } = n.node;
    const calls = item.fromRanges.length;
    return (
      <span className={styles.row} title={relativePath(projectRoot, item.path)}>
        <SymbolBadge kind={badgeKind(item.kind)} />
        <span className={styles.name}>{item.name}</span>
        {item.detail && <span className={styles.detail}>{item.detail}</span>}
        <span className={styles.muted}>
          {basename(item.path)}:{item.selectionRange.start.line + 1}
        </span>
        {calls > 1 && <span className={styles.muted}>({calls} calls)</span>}
        {failed.has(n.id) && <span className={styles.error}>failed to load</span>}
      </span>
    );
  };

  return (
    <div className={styles.view}>
      <HierarchyToolbar />
      <div className={styles.body}>
        <Tree<Node>
          key={generation}
          aria-label={mode === "call" ? "Call hierarchy" : "Type hierarchy"}
          roots={roots}
          getKey={(n) => n.id}
          getLabel={(n) => (n.kind === "root" ? root.name : n.node.item.name)}
          getChildren={getChildren}
          isExpandable={isExpandable}
          loadChildren={(n) => (n.kind === "item" ? loadChildren(n.node) : undefined)}
          defaultExpanded={[ROOT_ID]}
          renderNode={renderNode}
          activateExpandable
          multiSelect={false}
          onActivate={(n) => {
            if (n.kind === "root") openLocation(root.path, root.line, root.col);
            else {
              const target = n.node.item.selectionRange.start;
              openLocation(n.node.item.path, target.line, target.col);
            }
          }}
        />
      </div>
    </div>
  );
}
