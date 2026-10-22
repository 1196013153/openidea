/** Pure helpers of the database tools: clipboard formats, edits, labels. */
import type { DbCellValue, DbDriver, DbRowEdit, DataSource } from "@/platform/ipc";

export type Cell = string | null;

/** Tab-separated values (Excel / IDEA "Copy"): NULL is empty, tabs / newlines become spaces. */
export function toTsv(header: readonly string[] | null, rows: ReadonlyArray<readonly Cell[]>): string {
  const clean = (v: Cell) => (v ?? "").replace(/[\t\r\n]+/g, " ");
  const lines = rows.map((r) => r.map(clean).join("\t"));
  if (header) lines.unshift(header.map(clean).join("\t"));
  return lines.join("\n");
}

/** RFC 4180 CSV; NULL is an empty field. */
export function toCsv(header: readonly string[] | null, rows: ReadonlyArray<readonly Cell[]>): string {
  const field = (v: Cell) => {
    const s = v ?? "";
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) => r.map(field).join(","));
  if (header) lines.unshift(header.map(field).join(","));
  return lines.join("\r\n");
}

/** Pending changes of the table editor. Row indices refer to the loaded page. */
export interface PendingEdits {
  /** row → column → new value. */
  updates: Map<number, Map<string, Cell>>;
  deletes: Set<number>;
  /** New rows: column → value (absent columns use their default). */
  inserts: Array<Map<string, Cell>>;
}

export const emptyEdits = (): PendingEdits => ({ updates: new Map(), deletes: new Set(), inserts: [] });

export function hasEdits(e: PendingEdits): boolean {
  return e.updates.size > 0 || e.deletes.size > 0 || e.inserts.length > 0;
}

/** The DML requests for `edits` of a page with `columns` / `rows`, keyed by `primaryKey`. */
export function buildRowEdits(
  columns: readonly string[],
  rows: ReadonlyArray<readonly Cell[]>,
  primaryKey: readonly string[],
  edits: PendingEdits,
): DbRowEdit[] {
  const keyOf = (row: number): DbCellValue[] =>
    primaryKey.map((c) => ({ column: c, value: rows[row]?.[columns.indexOf(c)] ?? null }));
  const out: DbRowEdit[] = [];
  for (const [row, changes] of edits.updates) {
    if (edits.deletes.has(row) || !changes.size) continue;
    out.push({ kind: "update", key: keyOf(row), values: [...changes].map(([column, value]) => ({ column, value })) });
  }
  for (const row of [...edits.deletes].sort((a, b) => a - b)) out.push({ kind: "delete", key: keyOf(row) });
  for (const ins of edits.inserts) out.push({ kind: "insert", values: [...ins].map(([column, value]) => ({ column, value })) });
  return out;
}

/** IDEA's default name of a file data source: the file name without its extension (`shop.db` → `shop`). */
export function fileSourceName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.replace(/\.[^.]+$/, "") || base;
}

/** The tree / menu icon of a driver (IDEA shows the vendor's mark). */
export function driverIcon(driver: DbDriver | null | undefined): string {
  return driver === "postgres" ? "db-postgres" : driver === "mysql" ? "db-mysql" : "db-sqlite";
}

export function sourceLabel(s: Pick<DataSource, "name" | "driver">): string {
  const kind = s.driver === "postgres" ? "PostgreSQL" : s.driver === "mysql" ? "MySQL" : "SQLite";
  return `${s.name} (${kind})`;
}

export function newSourceId(): string {
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return rnd.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
}

/** What a failed connection needs from the user before retrying. */
export type ConnectRemedy = "password" | "sshSecret" | "trustHostKey" | null;

/**
 * Classifies a connection error: an unknown SSH host key to confirm, a missing
 * or rejected SSH password / passphrase, or a database password. A changed host
 * key is never offered for trust.
 */
export function connectRemedy(kind: string | undefined, message: string, source?: Pick<DataSource, "ssh">): ConnectRemedy {
  if (/^Unknown SSH host key/.test(message)) return "trustHostKey";
  if (kind !== "permissionDenied") return null;
  if (/^SSH host key .* has changed/.test(message)) return null;
  if (/^SSH (password|key passphrase) required|^cannot decrypt SSH key/.test(message)) return "sshSecret";
  if (/^SSH authentication failed/.test(message))
    // With OpenSSH config + agent there is nothing to type unless a key is encrypted.
    return source?.ssh?.auth === "openSsh" ? null : "sshSecret";
  return "password";
}

/** The SSH user@host of a data source, for prompts. */
export function sshLabel(source: Pick<DataSource, "ssh">): string {
  const ssh = source.ssh;
  if (!ssh?.host) return "";
  return `${ssh.user ? `${ssh.user}@` : ""}${ssh.host}${ssh.port ? `:${ssh.port}` : ""}`;
}

/**
 * Connection target (backend `split_target`): a data source id for its configured
 * database, or `<id>:<database>` for another database of the same server.
 */
export function splitTarget(target: string): { id: string; database: string | null } {
  const i = target.indexOf(":");
  return i < 0 ? { id: target, database: null } : { id: target.slice(0, i), database: target.slice(i + 1) || null };
}

/** The target of database `database` of data source `id`; the connected one is the data source itself. */
export function targetOf(id: string, database: string | null, current: string | null): string {
  return !database || database === current ? id : `${id}:${database}`;
}

/** Key of the Database tree node of database `name` of data source `id`. */
export const databaseKey = (id: string, name: string) => `${id}/@${name}`;

/**
 * Data Source from URL: `postgres://user:pass@host:5432/db`, `mysql://…`,
 * `mariadb://…`, the `jdbc:` forms of those, `jdbc:sqlite:path` / `sqlite:path`.
 * Null when the URL names no supported driver.
 */
export function parseSourceUrl(raw: string): { source: Partial<DataSource>; password: string | null } | null {
  const url = raw.trim().replace(/^jdbc:/i, "");
  const sqlite = /^sqlite:(?:\/\/)?(.+)$/i.exec(url);
  if (sqlite) {
    const file = sqlite[1]!.replace(/^\/([A-Za-z]:)/, "$1");
    return { source: { driver: "sqlite", file, name: fileSourceName(file) }, password: null };
  }
  const m = /^(postgres(?:ql)?|mysql|mariadb):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?]+|\[[^\]]+\])(?::(\d+))?(?:\/([^?]*))?(?:\?(.*))?$/i.exec(url);
  if (!m) return null;
  const dec = (s: string | undefined) => {
    try {
      return s ? decodeURIComponent(s) : "";
    } catch {
      return s ?? "";
    }
  };
  const driver = m[1]!.toLowerCase().startsWith("postgres") ? "postgres" : "mysql";
  const params = new URLSearchParams(m[7] ?? "");
  const user = dec(m[2]) || params.get("user") || "";
  const password = m[3] !== undefined ? dec(m[3]) : params.get("password");
  const port = m[5] ? parseInt(m[5], 10) : null;
  const source: Partial<DataSource> = { driver, host: m[4]!, port, user, database: dec(m[6]) };
  const ssl = params.get("sslmode")?.toLowerCase();
  if (ssl === "disable" || ssl === "require" || ssl === "prefer") source.ssl = ssl;
  return { source, password };
}
