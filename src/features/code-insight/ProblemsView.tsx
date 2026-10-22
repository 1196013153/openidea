/** Problems tool window: "File" (current editor) and "Project Errors" tabs. */
import { useCallback, useMemo, useState } from "react";
import { create } from "zustand";
import clsx from "clsx";
import type { Diagnostic, Severity } from "@/bindings";
import { useEditorRegistry } from "@/editor/api";
import { basename, relativeDir, useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import { EmptyState, Icon, IconButton, Tabs, Tree, fileIconName, type TreeRowState } from "@/ui";
import { countSeverities, fileDiagnostics, useProblems, type ProblemsMap } from "./problemsStore";
import styles from "./ProblemsView.module.css";

type Tab = "file" | "project";

interface ViewState {
  tab: Tab;
  show: Record<"error" | "warning" | "info", boolean>;
  setTab(tab: Tab): void;
  toggle(sev: "error" | "warning" | "info"): void;
}

export const useProblemsView = create<ViewState>((set) => ({
  tab: "file",
  show: { error: true, warning: true, info: true },
  setTab: (tab) => set({ tab }),
  toggle: (sev) => set((s) => ({ show: { ...s.show, [sev]: !s.show[sev] } })),
}));

const group = (s: Severity): "error" | "warning" | "info" => (s === "hint" ? "info" : s);

type Node =
  | { kind: "file"; key: string; path: string; items: Diagnostic[] }
  | { kind: "diag"; key: string; path: string; d: Diagnostic };

const plural = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? "" : "s"}` : "");

const SEVERITY_ICON: Record<Severity, string> = { error: "error", warning: "warning", info: "info", hint: "info" };

export function buildProblemNodes(map: ProblemsMap, paths: readonly string[], show: ViewState["show"]): Node[] {
  const files: Node[] = [];
  for (const path of paths) {
    const items = fileDiagnostics(map, path).filter((d) => show[group(d.severity)]);
    if (!items.length) continue;
    files.push({ kind: "file", key: path, path, items });
  }
  const rank = (n: Node) => (n.kind === "file" ? (n.items.some((d) => d.severity === "error") ? 0 : 1) : 2);
  return files.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

function open(path: string, d: Diagnostic, focus = true) {
  void editorService().openFile(path, {
    selection: { line: d.range.start.line, col: d.range.start.col },
    focus,
    preview: !focus,
  });
}

function useCurrentPath(): string | null {
  return useEditorRegistry((s) => s.active?.ctx.path ?? null);
}

export function ProblemsHeaderActions() {
  const show = useProblemsView((s) => s.show);
  const toggle = useProblemsView((s) => s.toggle);
  return (
    <>
      <IconButton icon="error" title="Show Errors" size="small" pressed={show.error} onClick={() => toggle("error")} />
      <IconButton icon="warning" title="Show Warnings" size="small" pressed={show.warning} onClick={() => toggle("warning")} />
      <IconButton icon="info" title="Show Infos and Hints" size="small" pressed={show.info} onClick={() => toggle("info")} />
    </>
  );
}

/** Scope tabs in the tool window header: "File: name  2" / "Project Errors". */
export function ProblemsTabs() {
  const map = useProblems((s) => s.map);
  const tab = useProblemsView((s) => s.tab);
  const setTab = useProblemsView((s) => s.setTab);
  const current = useCurrentPath();
  const fileCount = current ? countSeverities(fileDiagnostics(map, current)) : null;
  const projectErrors = useMemo(() => {
    let n = 0;
    for (const sources of map.values()) for (const items of sources.values()) n += items.filter((d) => d.severity === "error").length;
    return n;
  }, [map]);
  return (
    <Tabs
      variant="compact"
      aria-label="Problems scope"
      className={styles.tabs}
      activeId={tab}
      onSelect={(id) => setTab(id as Tab)}
      items={[
        {
          id: "file",
          label: current ? (
            <>
              File <span className={styles.tabFile}>{basename(current)}</span>
            </>
          ) : (
            "File"
          ),
          text: "File",
          trailing:
            fileCount && fileCount.error + fileCount.warning > 0 ? (
              <span className={styles.tabCount}>{fileCount.error + fileCount.warning}</span>
            ) : undefined,
        },
        {
          id: "project",
          label: "Project Errors",
          trailing: projectErrors ? <span className={styles.tabCount}>{projectErrors}</span> : undefined,
        },
      ]}
    />
  );
}

export function ProblemsView() {
  const map = useProblems((s) => s.map);
  const { tab, show } = useProblemsView();
  const current = useCurrentPath();
  const root = useProject((s) => s.project?.root ?? "");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const roots = useMemo(() => {
    const paths = tab === "file" ? (current ? [current] : []) : [...map.keys()];
    return buildProblemNodes(map, paths, show);
  }, [map, tab, current, show]);

  const expanded = useMemo(() => new Set(roots.filter((r) => !collapsed.has(r.key)).map((r) => r.key)), [roots, collapsed]);

  const getChildren = useCallback(
    (n: Node): Node[] | undefined =>
      n.kind === "file"
        ? n.items.map((d, i) => ({ kind: "diag", key: `${n.path}\u0000${i}`, path: n.path, d }) as Node)
        : undefined,
    [],
  );

  const renderNode = (n: Node, state: TreeRowState) => {
    if (n.kind === "file") {
      const c = countSeverities(n.items);
      const parts = [
        plural(c.error, "error"),
        plural(c.warning, "warning"),
        plural(c.info + c.hint, "info"),
      ].filter(Boolean);
      return (
        <span className={styles.row}>
          <Icon name={fileIconName(basename(n.path))} size={16} className={styles.fileIcon} />
          <span className={clsx(styles.fileName, c.error > 0 && styles.fileError, state.selected && styles.selectedText)}>
            {basename(n.path)}
          </span>
          <span className={styles.muted}>{relativeDir(root, n.path)}</span>
          <span className={styles.count}>{parts.join(", ")}</span>
        </span>
      );
    }
    const d = n.d;
    return (
      <span className={styles.row} title={d.message}>
        <Icon name={SEVERITY_ICON[d.severity]} size={14} className={styles[`sev-${d.severity}`]} />
        <span className={clsx(styles.message, d.deprecated && styles.deprecated)}>{d.message.split("\n")[0]}</span>
        <span className={styles.position}>:{d.range.start.line + 1}</span>
        {d.source && (
          <span className={styles.source}>
            {d.source}
            {d.code ? `(${d.code})` : ""}
          </span>
        )}
      </span>
    );
  };

  const empty =
    tab === "file" && !current ? (
      <EmptyState icon="problems" title="No file is open" />
    ) : (
      <EmptyState icon="check" title={tab === "file" ? "No problems in this file" : "No problems found"} />
    );

  return (
    <div className={styles.view}>
      <div className={styles.body}>
        <Tree<Node>
          aria-label="Problems"
          roots={roots}
          getKey={(n) => n.key}
          getLabel={(n) => (n.kind === "file" ? basename(n.path) : n.d.message)}
          getChildren={getChildren}
          isExpandable={(n) => n.kind === "file"}
          expanded={expanded}
          onExpandedChange={(_next, node, isOpen) =>
            setCollapsed((prev) => {
              const s = new Set(prev);
              if (isOpen) s.delete(node.key);
              else s.add(node.key);
              return s;
            })
          }
          renderNode={renderNode}
          onActivate={(n) => {
            if (n.kind === "diag") open(n.path, n.d);
            else if (n.items[0]) open(n.path, n.items[0]);
          }}
          onSelectionChange={(_sel, lead) => {
            // IDEA's autoscroll-to-source: selecting a problem shows it without leaving the list.
            if (lead?.kind === "diag") open(lead.path, lead.d, false);
          }}
          activateExpandable={false}
          multiSelect={false}
          empty={empty}
        />
      </div>
    </div>
  );
}
