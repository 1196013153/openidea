/** Nodes of the Database tool window tree and the objects they stand for. */
import type { DataSource, DbColumnInfo, DbForeignKey, DbIndexInfo, DbTableInfo } from "@/platform/ipc";
import type { DbObjectRef } from "./objects";

export type Group = "columns" | "keys" | "foreignKeys" | "indexes";

/** Where a table-level node lives: connection target, schema, table. */
interface InTable {
  id: string;
  schema: string;
  table: string;
}

export type DbNode =
  | { kind: "source"; key: string; source: DataSource }
  /** A database of a PostgreSQL server; `id` is its connection target. */
  | { kind: "database"; key: string; id: string; name: string; current: boolean }
  | { kind: "schema"; key: string; id: string; schema: string }
  | { kind: "folder"; key: string; id: string; schema: string; folder: "tables" | "views" }
  | { kind: "table"; key: string; id: string; schema: string; table: DbTableInfo }
  | ({ kind: "group"; key: string; group: Group } & InTable)
  | ({ kind: "column"; key: string; column: DbColumnInfo; foreignKey: boolean } & InTable)
  | ({ kind: "key"; key: string; columns: string[] } & InTable)
  | ({ kind: "foreignKey"; key: string; fk: DbForeignKey } & InTable)
  | ({ kind: "index"; key: string; index: DbIndexInfo } & InTable)
  | { kind: "message"; key: string; text: string; error?: boolean };

/** The connection target a node belongs to. */
export function nodeTarget(n: DbNode): string | null {
  if (n.kind === "source") return n.source.id ?? null;
  if ("id" in n && typeof n.id === "string") return n.id;
  return n.key.split("/")[0] ?? null;
}

/** The table (or view) a node is, or is inside of. */
export function tableOf(n: DbNode): { id: string; schema: string; table: string; view: boolean } | null {
  if (n.kind === "table") return { id: n.id, schema: n.schema, table: n.table.name, view: n.table.kind === "view" };
  if ("table" in n && typeof n.table === "string") return { id: n.id, schema: n.schema, table: n.table, view: false };
  return null;
}

/** The schema object a node stands for (Rename, Drop, Copy Reference). */
export function objectOf(n: DbNode): DbObjectRef | null {
  switch (n.kind) {
    case "schema":
      return { kind: "schema", schema: n.schema, name: n.schema };
    case "table":
      return { kind: n.table.kind === "view" ? "view" : "table", schema: n.schema, name: n.table.name };
    case "column":
      return { kind: "column", schema: n.schema, name: n.table, column: n.column.name };
    case "index":
      return { kind: "index", schema: n.schema, name: n.index.name, table: n.table };
    default:
      return null;
  }
}
