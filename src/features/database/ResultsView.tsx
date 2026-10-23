/**
 * Database Console service view (IDEA's): an Output tab logging every
 * executed statement with its outcome, and a `Result N` tab per result set —
 * a toolbar (re-run, export / copy as CSV, JSON, SQL…), the grid and a floating row count.
 */
import { useEffect, useRef } from "react";
import clsx from "clsx";
import { call, commands } from "@/platform/ipc";
import { EmptyState, IconButton, Spinner, Tabs, showContextMenu, type MenuItem, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { EXPORT_FORMATS, exportData, type ExportData, type ExportFormat } from "./export";
import { Grid } from "./Grid";
import { analyze } from "./sql/analyze";
import {
  OUTPUT_TAB,
  clearOutput,
  closeResult,
  outcomeSummary,
  rerunResult,
  sourceById,
  targetLabel,
  useDatabase,
  type OutputLine,
  type ResultTab,
} from "./store";
import styles from "./Database.module.css";

function time(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function Output() {
  const lines = useDatabase((s) => s.output);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <span className={styles.spacer} />
        <IconButton icon="trash" title="Clear All" disabled={!lines.length} onClick={clearOutput} />
      </div>
      <div ref={ref} className={styles.output} role="log" aria-label="Database output">
        {lines.map((l: OutputLine) => (
          <div key={l.id} className={clsx(styles.outputLine, l.kind === "error" && styles.outputError)}>
            <span className={styles.outputTime}>[{time(l.time)}]</span>{" "}
            {l.prompt && <span className={styles.outputPrompt}>{l.prompt} </span>}
            <span className={l.kind === "statement" ? styles.outputStatement : undefined}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The table a query reads (target of exported SQL inserts), else IDEA's placeholder. */
function queryTable(text: string, data: Pick<ExportData, "driver">): string {
  const a = analyze(text, text.length, data.driver);
  return a.refs.find((r) => r.depth === 0 && r.kind === "table")?.name ?? "MY_TABLE";
}

async function saveExport(format: ExportFormat, data: ExportData) {
  const f = EXPORT_FORMATS.find((x) => x.id === format)!;
  let path: string | null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    path = await save({
      defaultPath: `${data.table}.${f.extension}`,
      filters: [{ name: f.label, extensions: [f.extension] }],
    });
  } catch {
    return;
  }
  if (!path) return;
  try {
    await call(commands.dbExportFile(path, exportData(format, data)));
    notifications().notify({ level: "info", title: `${data.rows.length} rows exported`, body: path, key: "db-export" });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot export data",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

function exportMenu(data: ExportData): MenuItem[] {
  return [
    ...EXPORT_FORMATS.map((f): MenuItem => ({
      label: `Copy as ${f.label}`,
      icon: "copy",
      run: () => void navigator.clipboard?.writeText(exportData(f.id, data)),
    })),
    { kind: "separator" },
    ...EXPORT_FORMATS.map((f): MenuItem => ({
      label: `Export to ${f.label} File…`,
      run: () => void saveExport(f.id, data),
    })),
  ];
}

function Result({ tab }: { tab: ResultTab }) {
  const r = tab.outcome.result;
  if (!r) return null;
  const driver = sourceById(tab.sourceId)?.driver ?? "sqlite";
  const data = (): ExportData => ({
    columns: r.columns.map((c) => ({ name: c.name, type: c.typeName })),
    rows: r.rows,
    driver,
    table: queryTable(tab.outcome.statement.text, { driver }),
  });
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <IconButton icon="refresh" title="Rerun Query" disabled={tab.busy} onClick={() => void rerunResult(tab.id)} />
        <span className={styles.toolbarSeparator} />
        <IconButton icon="export" title="Export Data" onClick={(e) => showContextMenu(e, exportMenu(data()))} />
        {tab.busy && <Spinner size={12} />}
        <span className={styles.spacer} />
        <span className={styles.resultSource} title={tab.outcome.statement.text}>
          {targetLabel(tab.sourceId)}
        </span>
      </div>
      <div className={clsx(styles.fill, styles.gridHost)}>
        <Grid
          columns={r.columns.map((c) => ({ name: c.name, type: c.typeName }))}
          rowCount={r.rows.length}
          value={(row, col) => r.rows[row]?.[col] ?? null}
        />
        <div className={styles.rowPill} role="status" title={outcomeSummary(tab.outcome)}>
          {r.rows.length} row{r.rows.length === 1 ? "" : "s"}
          {r.hasMore ? " (limit reached)" : ""}
        </div>
      </div>
    </div>
  );
}

export function ResultsView() {
  const results = useDatabase((s) => s.results);
  const active = useDatabase((s) => s.activeResult);
  const hasOutput = useDatabase((s) => s.output.length > 0);
  if (!results.length && !hasOutput)
    return (
      <EmptyState title="No results">
        <T>Execute a statement in a query console with ⌘↩.</T>
      </EmptyState>
    );
  const tab = results.find((r) => r.id === active);
  return (
    <div className={styles.view}>
      <Tabs
        variant="compact"
        aria-label="Results"
        activeId={tab ? String(tab.id) : String(OUTPUT_TAB)}
        onSelect={(id) => useDatabase.setState({ activeResult: Number(id) })}
        onClose={(id) => closeResult(Number(id))}
        items={[
          { id: String(OUTPUT_TAB), label: "Output", icon: "db-console", closable: false },
          ...results.map((r) => ({
            id: String(r.id),
            label: r.title,
            icon: "db-table",
            closable: true,
            tooltip: r.outcome.statement.text,
          })),
        ]}
      />
      <div className={styles.fill}>{tab ? <Result key={tab.id} tab={tab} /> : <Output />}</div>
    </div>
  );
}
