/**
 * Local History editor tab: revisions of a file — or, for a folder, of every
 * file under it (deleted ones included) — plus labels and system events
 * ("Before Git checkout"), with diff and revert.
 */
import { useCallback, useEffect, useState } from "react";
import type { HistoryEntry } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { relativePath, useProject } from "@/platform/project";
import { Button, Icon, List, Spinner, T } from "@/ui";
import { notifications, type EditorInput } from "@/workbench/contributions";
import { DiffEditor } from "./DiffEditor";
import { confirmDialog } from "./dialogs";
import { diffInput } from "./diffInput";
import { baseName, formatTime } from "./model";
import { errorMessage, runOp } from "./ops";
import styles from "./LocalHistory.module.css";

export { LOCAL_HISTORY_KIND, localHistoryInput, openLocalHistory } from "./localHistoryKind";

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const isLabel = (e: HistoryEntry) => e.kind === "label";
const time = (e: HistoryEntry) => e.timestampMs ?? 0;

/** Per file, the newest snapshot recorded before `at` (the state at a label). */
export function snapshotsBefore(entries: readonly HistoryEntry[], at: number): Map<string, HistoryEntry> {
  const out = new Map<string, HistoryEntry>();
  for (const e of entries) {
    if (isLabel(e) || time(e) >= at) continue;
    const prev = out.get(e.path);
    if (!prev || time(prev) < time(e)) out.set(e.path, e);
  }
  return out;
}

export interface HistoryView {
  entries: HistoryEntry[];
  deleted: ReadonlySet<string>;
  /** Snapshots of files other than the opened path: a folder's history. */
  folder: boolean;
}

export function LocalHistoryEditor({ input }: { input: EditorInput }) {
  const { path } = input.data as { path: string };
  const root = useProject((s) => s.project?.root ?? "");
  const [view, setView] = useState<HistoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const load = useCallback(() => {
    call(commands.historyListDir(path))
      .then((h) => {
        const entries = [...h.entries].sort((a, b) => time(b) - time(a));
        const folder = entries.some((e) => !isLabel(e) && e.path !== path);
        setView({ entries, deleted: new Set(h.deleted), folder });
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [path]);
  useEffect(load, [load]);

  const entries = view?.entries ?? [];
  const current = entries[Math.min(active, entries.length - 1)];
  const atLabel = current && isLabel(current) ? snapshotsBefore(entries, time(current)) : null;
  // A file's history at a label: its last revision before the label.
  const fileAtLabel = atLabel && !view?.folder ? atLabel.get(path) : undefined;

  const restore = async (targets: HistoryEntry[], what: string) => {
    const ok = await confirmDialog({ title: "Revert", message: `Revert ${what}?`, okLabel: "Revert" });
    if (!ok) return;
    await runOp(
      `Revert ${what} from Local History`,
      async () => {
        for (const e of targets) await call(commands.historyRestore(e.path, e.id));
      },
      {
        success: targets.length === 1 ? `${baseName(targets[0]!.path)} reverted` : `${targets.length} files reverted`,
        refresh: true,
      },
    );
    load();
  };

  const revert = () => {
    if (!current || !view) return;
    if (!isLabel(current)) {
      void restore(
        [current],
        `${baseName(current.path)} to the revision from ${formatTime(current.timestampMs)} (${current.label})`,
      );
      return;
    }
    const targets = view.folder ? [...(atLabel?.values() ?? [])] : fileAtLabel ? [fileAtLabel] : [];
    if (!targets.length) {
      notifications().notify({
        level: "info",
        title: "Nothing recorded before this label",
        key: "localHistory.revert",
      });
      return;
    }
    void restore(
      targets,
      `${view.folder ? `${targets.length} files under ${baseName(path)}` : baseName(path)} to label '${current.label}'`,
    );
  };

  const diffFor = (e: HistoryEntry | undefined, deleted: boolean) =>
    e && (
      <DiffEditor
        key={e.id + e.path}
        input={diffInput({
          path: e.path,
          left: { type: "history", id: e.id, label: `${formatTime(e.timestampMs)} · ${e.label}` },
          right: deleted ? { type: "text", text: "", label: "Deleted" } : { type: "worktree", label: "Current" },
        })}
      />
    );

  let detail;
  if (!current)
    detail = (
      <div className={styles.message}>
        <T>Select a revision</T>
      </div>
    );
  else if (!isLabel(current)) detail = diffFor(current, !!view?.deleted.has(current.path));
  else if (fileAtLabel) detail = diffFor(fileAtLabel, !!view?.deleted.has(path));
  else
    detail = (
      <div className={styles.message}>
        Label '{current.label}'
        {view?.folder && atLabel?.size
          ? ` · ${atLabel.size} ${atLabel.size === 1 ? "file" : "files"} recorded before it`
          : ""}
      </div>
    );

  const revertLabel = current && !isLabel(current) && view?.deleted.has(current.path) ? "Restore" : "Revert";

  return (
    <div className={styles.root}>
      <div className={styles.sidebar}>
        <div className={styles.header}>
          <span className={styles.title}>
            <T>Local History</T>
          </span>
          <Button size="small" disabled={!current} onClick={revert}>
            {revertLabel}
          </Button>
        </div>
        {error ? (
          <div className={styles.message}>{error}</div>
        ) : !view ? (
          <div className={styles.message}>
            <Spinner size={14} />
          </div>
        ) : (
          <List
            items={entries}
            getKey={(e) => `${e.kind ?? "snapshot"}:${e.id}:${e.path}:${e.timestampMs ?? ""}`}
            activeIndex={Math.min(active, entries.length - 1)}
            onActiveChange={setActive}
            onActivate={(_e, i) => setActive(i)}
            rowHeight={view.folder ? 52 : 38}
            aria-label="Revisions"
            className={styles.list}
            empty={
              <span className={styles.message}>No local history for this {view.folder ? "folder" : "path"} yet</span>
            }
            renderItem={(e) =>
              isLabel(e) ? (
                <span className={styles.entry}>
                  <span className={styles.time}>{formatTime(e.timestampMs)}</span>
                  <span className={styles.labelRow}>
                    <Icon name="bookmark" size={12} />
                    <span className={styles.labelName}>{e.label}</span>
                  </span>
                </span>
              ) : (
                <span className={styles.entry}>
                  <span className={styles.time}>{formatTime(e.timestampMs)}</span>
                  {view.folder && (
                    <span className={view.deleted.has(e.path) ? styles.deletedPath : styles.path}>
                      {relativePath(root, e.path) || baseName(e.path)}
                    </span>
                  )}
                  <span className={styles.label}>
                    {e.label} · {formatSize(e.size)}
                  </span>
                </span>
              )
            }
          />
        )}
      </div>
      <div className={styles.diff}>{detail}</div>
    </div>
  );
}
