/**
 * Result-set export formats (IDEA's data extractors): CSV, TSV, JSON, SQL
 * INSERT statements and a Markdown table. Values arrive as text; numeric
 * columns are written unquoted where the format distinguishes them.
 */
import type { DbDriver } from "@/platform/ipc";
import { isNumericColumn } from "./Grid";
import { toCsv, toTsv, type Cell } from "./model";
import { quoteIdent } from "./sql/complete";

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown";

export const EXPORT_FORMATS: ReadonlyArray<{ id: ExportFormat; label: string; extension: string }> = [
  { id: "csv", label: "CSV", extension: "csv" },
  { id: "tsv", label: "TSV", extension: "tsv" },
  { id: "json", label: "JSON", extension: "json" },
  { id: "sql", label: "SQL Inserts", extension: "sql" },
  { id: "markdown", label: "Markdown", extension: "md" },
];

export interface ExportData {
  columns: ReadonlyArray<{ name: string; type: string }>;
  rows: ReadonlyArray<readonly Cell[]>;
  /** Target of SQL inserts (the query's table, when it reads one). */
  table: string;
  driver: DbDriver;
}

export function exportData(format: ExportFormat, d: ExportData): string {
  const names = d.columns.map((c) => c.name);
  const numeric = d.columns.map((c, i) =>
    isNumericColumn(
      c.type,
      d.rows.slice(0, 50).map((r) => r[i] ?? null),
    ),
  );
  switch (format) {
    case "csv":
      return toCsv(names, d.rows);
    case "tsv":
      return toTsv(names, d.rows);
    case "json": {
      const value = (v: Cell, i: number) => (v === null ? null : numeric[i] && Number.isFinite(Number(v)) ? Number(v) : v);
      return JSON.stringify(
        d.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, value(r[i] ?? null, i)]))),
        null,
        2,
      );
    }
    case "sql": {
      const literal = (v: Cell, i: number) =>
        v === null ? "NULL" : numeric[i] && Number.isFinite(Number(v)) ? v : `'${v.replace(/'/g, "''")}'`;
      const head = `INSERT INTO ${quoteIdent(d.table, d.driver)} (${names.map((n) => quoteIdent(n, d.driver)).join(", ")}) VALUES`;
      return d.rows.map((r) => `${head} (${r.map(literal).join(", ")});`).join("\n");
    }
    case "markdown": {
      const cell = (v: Cell) => (v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
      const align = numeric.map((n) => (n ? "--:" : "---"));
      return [names.map(cell), align, ...d.rows.map((r) => r.map(cell))].map((r) => `| ${r.join(" | ")} |`).join("\n");
    }
  }
}
