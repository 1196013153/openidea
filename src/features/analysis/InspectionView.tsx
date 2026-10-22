/** Inspection Results tool window: severity → inspection → file → problem. */
import { useCallback, useMemo, useState } from "react";
import { basename, relativeDir, useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import { EmptyState, Icon, IconButton, ProgressBar, Tree, fileIconName, type TreeRowState } from "@/ui";
import {
  cancelInspection,
  groupInspection,
  rerunInspection,
  useInspection,
  type InspectionProblem,
  type SeverityKey,
} from "./inspect";
import styles from "./Analysis.module.css";

type Node =
  | { kind: "severity"; key: string; severity: SeverityKey; count: number; children: Node[] }
  | { kind: "inspection"; key: string; name: string; count: number; children: Node[] }
  | { kind: "file"; key: string; path: string; count: number; children: Node[] }
  | { kind: "problem"; key: string; p: InspectionProblem };

const SEVERITY_LABEL: Record<SeverityKey, string> = {
  error: "Errors",
  warning: "Warnings",
  info: "Weak warnings and hints",
};

export function buildInspectionNodes(groups: ReturnType<typeof groupInspection>): Node[] {
  return groups.map((s) => ({
    kind: "severity",
    key: s.severity,
    severity: s.severity,
    count: s.count,
    children: s.kinds.map((k) => {
      const kindKey = `${s.severity}\u0000${k.kind}`;
      return {
        kind: "inspection",
        key: kindKey,
        name: k.kind,
        count: k.count,
        children: k.files.map((f) => {
          const fileKey = `${kindKey}\u0000${f.path}`;
          return {
            kind: "file",
            key: fileKey,
            path: f.path,
            count: f.problems.length,
            children: f.problems.map((p, i) => ({ kind: "problem", key: `${fileKey}\u0000${i}`, p }) as Node),
          } as Node;
        }),
      } as Node;
    }),
  }));
}

function open(p: InspectionProblem, focus = true) {
  void editorService().openFile(p.path, {
    selection: { line: p.d.range.start.line, col: p.d.range.start.col },
    focus,
    preview: !focus,
  });
}

export function InspectionHeaderActions() {
  const running = useInspection((s) => s.running);
  const last = useInspection((s) => s.last);
  return (
    <>
      <IconButton
        icon="rerun"
        title="Rerun Inspection"
        size="small"
        disabled={!last || running}
        onClick={rerunInspection}
      />
      <IconButton icon="stop" title="Stop" size="small" disabled={!running} onClick={cancelInspection} />
    </>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function InspectionView() {
  const { files, running, total, done, summary, scopeLabel, error } = useInspection();
  const root = useProject((s) => s.project?.root ?? "");
  const roots = useMemo(() => buildInspectionNodes(groupInspection(files.values())), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Severities and inspections start expanded; files too unless there are many problems.
  const expanded = useMemo(() => {
    const out = new Set<string>();
    const total = roots.reduce((n, r) => n + (r.kind === "severity" ? r.count : 0), 0);
    const depthOpen = total <= 200 ? 3 : 2;
    const visit = (nodes: Node[], depth: number) => {
      for (const n of nodes) {
        if (n.kind === "problem") continue;
        if (!collapsed.has(n.key) && depth < depthOpen) out.add(n.key);
        visit(n.children, depth + 1);
      }
    };
    visit(roots, 0);
    return out;
  }, [roots, collapsed]);

  const getChildren = useCallback((n: Node) => (n.kind === "problem" ? undefined : n.children), []);

  const renderNode = (n: Node, state: TreeRowState) => {
    switch (n.kind) {
      case "severity":
        return (
          <span className={styles.row}>
            <Icon name={n.severity} size={14} className={styles[`sev-${n.severity}`]} />
            <span className={styles.strong}>{SEVERITY_LABEL[n.severity]}</span>
            <span className={styles.count}>{plural(n.count, "problem")}</span>
          </span>
        );
      case "inspection":
        return (
          <span className={styles.row}>
            <span className={styles.strong}>{n.name}</span>
            <span className={styles.count}>{n.count}</span>
          </span>
        );
      case "file":
        return (
          <span className={styles.row}>
            <Icon name={fileIconName(basename(n.path))} size={16} className={styles.fileIcon} />
            <span className={state.selected ? styles.strong : undefined}>{basename(n.path)}</span>
            <span className={styles.muted}>{relativeDir(root, n.path)}</span>
            <span className={styles.count}>{n.count}</span>
          </span>
        );
      case "problem":
        return (
          <span className={styles.row} title={n.p.d.message}>
            <span className={styles.message}>{n.p.d.message.split("\n")[0]}</span>
            <span className={styles.muted}>:{n.p.d.range.start.line + 1}</span>
          </span>
        );
    }
  };

  const status = running
    ? `Inspecting ${scopeLabel ?? ""}… ${done}/${total || "?"} files`
    : summary
      ? `${scopeLabel}: ${plural(summary.problems, "problem")} in ${plural(summary.files, "file")}` +
        (summary.skipped ? `, ${summary.skipped} without a language server` : "") +
        (summary.failed ? `, ${summary.failed} failed` : "") +
        (summary.cancelled ? " (stopped)" : "")
      : null;

  return (
    <div className={styles.view}>
      {status && (
        <div className={styles.status} role="status">
          <span className={styles.statusText}>{status}</span>
          {running && (
            <ProgressBar
              value={total ? done / total : null}
              className={styles.progress}
              aria-label="Inspection progress"
            />
          )}
        </div>
      )}
      <div className={styles.body}>
        <Tree<Node>
          aria-label="Inspection results"
          roots={roots}
          getKey={(n) => n.key}
          getLabel={(n) =>
            n.kind === "severity"
              ? SEVERITY_LABEL[n.severity]
              : n.kind === "inspection"
                ? n.name
                : n.kind === "file"
                  ? basename(n.path)
                  : n.p.d.message
          }
          getChildren={getChildren}
          isExpandable={(n) => n.kind !== "problem"}
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
            if (n.kind === "problem") open(n.p);
          }}
          onSelectionChange={(_sel, lead) => {
            if (lead?.kind === "problem") open(lead.p, false);
          }}
          activateExpandable={false}
          multiSelect={false}
          empty={
            error ? (
              <EmptyState icon="error" title={error} />
            ) : running ? (
              <EmptyState icon="problems" title="Inspecting…" />
            ) : summary ? (
              <EmptyState icon="check" title="No problems found" />
            ) : (
              <EmptyState icon="problems" title="Run Code › Inspect Code… to analyse files" />
            )
          }
        />
      </div>
    </div>
  );
}
