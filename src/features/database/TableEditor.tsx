/**
 * Table data editor (editor tab): pages of rows with sorting (header click),
 * a WHERE filter, and pending cell edits / added / deleted rows submitted
 * together in one transaction. Tables without a primary key are read-only.
 */
import { useEffect, useState } from "react";
import { call, commands, isCancelled, nextRequestId, type DbSortKey, type DbTablePage, type RequestId } from "@/platform/ipc";
import { Button, EmptyState, IconButton, Input, Select, Spinner } from "@/ui";
import { notifications, type EditorInput } from "@/workbench/contributions";
import { Grid } from "./Grid";
import { buildRowEdits, emptyEdits, hasEdits, type Cell, type PendingEdits } from "./model";
import { sourceById, withConnection } from "./store";
import type { TableRef } from "./tableInput";
import styles from "./Database.module.css";

const PAGE_SIZES = ["100", "500", "1000", "5000"];

export { tableTitle } from "./tableInput";

export function TableEditor({ input }: { input: EditorInput }) {
  const ref = input.data as TableRef;
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(500);
  const [sort, setSort] = useState<DbSortKey[]>([]);
  const [filterText, setFilterText] = useState("");
  const [filter, setFilter] = useState("");
  const [nonce, setNonce] = useState(0);
  const [edits, setEdits] = useState<PendingEdits>(emptyEdits);
  // The page for the current parameters (`key`); stale while loading.
  const [loadedPage, setLoadedPage] = useState<{ key: string; page: DbTablePage | null; error: string | null } | null>(
    null,
  );
  const key = JSON.stringify([ref.id, ref.schema, ref.table, filter, sort, offset, limit, nonce]);
  const loading = loadedPage?.key !== key;
  const page = loadedPage?.page ?? null;
  const error = loadedPage?.error ?? null;
  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    const id: RequestId = nextRequestId();
    let done = false;
    void (async () => {
      try {
        const p = await withConnection(ref.id, () =>
          call(commands.dbTablePage(id, ref.id, ref.schema, ref.table, filter || null, sort, offset, limit)),
        );
        setLoadedPage({ key, page: p, error: null });
        setEdits(emptyEdits());
      } catch (e) {
        if (!isCancelled(e)) setLoadedPage((prev) => ({ key, page: prev?.page ?? null, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        done = true;
      }
    })();
    return () => {
      if (!done) void commands.cancelRequest(id);
    };
  }, [key, ref.id, ref.schema, ref.table, filter, sort, offset, limit]);

  const columns = page?.result.columns ?? [];
  const names = columns.map((c) => c.name);
  const pk = page?.details.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [];
  const fkColumns = new Set(page?.details.foreignKeys.flatMap((k) => k.columns) ?? []);
  const editable = pk.length > 0 && !sourceById(ref.id)?.readOnly;
  const loaded = page?.result.rows.length ?? 0;
  const rowCount = loaded + edits.inserts.length;

  const value = (row: number, col: number): Cell => {
    const name = names[col]!;
    if (row >= loaded) {
      const ins = edits.inserts[row - loaded];
      return ins?.has(name) ? ins.get(name)! : null;
    }
    const upd = edits.updates.get(row);
    if (upd?.has(name)) return upd.get(name)!;
    return page?.result.rows[row]?.[col] ?? null;
  };

  const onEdit = (row: number, col: number, v: Cell) => {
    const name = names[col]!;
    setEdits((e) => {
      const next: PendingEdits = { updates: new Map(e.updates), deletes: new Set(e.deletes), inserts: [...e.inserts] };
      if (row >= loaded) {
        const ins = new Map(next.inserts[row - loaded]);
        ins.set(name, v);
        next.inserts[row - loaded] = ins;
      } else {
        const upd = new Map(next.updates.get(row));
        if ((page?.result.rows[row]?.[col] ?? null) === v) upd.delete(name);
        else upd.set(name, v);
        if (upd.size) next.updates.set(row, upd);
        else next.updates.delete(row);
      }
      return next;
    });
  };

  const deleteRows = (rows: number[]) =>
    setEdits((e) => {
      const deletes = new Set(e.deletes);
      const insertsGone = new Set(rows.filter((r) => r >= loaded).map((r) => r - loaded));
      for (const r of rows) if (r < loaded) deletes.add(r);
      return { ...e, deletes, inserts: e.inserts.filter((_, i) => !insertsGone.has(i)) };
    });

  const submit = async () => {
    if (!page) return;
    try {
      const n = await call(
        commands.dbApplyEdits(ref.id, ref.schema, ref.table, buildRowEdits(names, page.result.rows, pk, edits)),
      );
      notifications().notify({ level: "info", title: `${ref.table}: ${n} row(s) changed`, key: "db-submit" });
      reload();
    } catch (e) {
      notifications().notify({
        level: "error",
        title: "Changes were not submitted",
        body: e instanceof Error ? e.message : String(e),
        key: "db-submit",
      });
    }
  };

  const onSort = (column: string, add: boolean) =>
    setSort((s) => {
      const cur = s.find((k) => k.column === column);
      // asc → desc → none.
      const next = !cur ? { column, descending: false } : !cur.descending ? { column, descending: true } : null;
      const rest = add ? s.filter((k) => k.column !== column) : [];
      return next ? [...rest, next] : rest;
    });

  const dirty = hasEdits(edits);
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <IconButton icon="refresh" title="Reload Page" onClick={reload} disabled={loading} />
        <div className={styles.pager}>
          <IconButton
            icon="chevron-left"
            title="Previous Page"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          />
          <span>
            {loaded ? `${offset + 1}–${offset + loaded}` : "0"}
            {page?.result.hasMore ? " of more" : ""}
          </span>
          <IconButton
            icon="chevron-right"
            title="Next Page"
            disabled={!page?.result.hasMore || loading}
            onClick={() => setOffset(offset + limit)}
          />
          <Select
            aria-label="Page size"
            value={String(limit)}
            options={PAGE_SIZES.map((v) => ({ value: v, label: v }))}
            onChange={(v) => {
              setOffset(0);
              setLimit(Number(v));
            }}
          />
        </div>
        <Input
          className={styles.filter}
          mono
          aria-label="WHERE filter"
          placeholder="WHERE (e.g. id > 10)"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setOffset(0);
              setFilter(filterText.trim());
            }
          }}
        />
        {editable && (
          <>
            <IconButton
              icon="plus"
              title="Add Row"
              onClick={() => setEdits((e) => ({ ...e, inserts: [...e.inserts, new Map()] }))}
            />
            <Button size="small" variant="primary" disabled={!dirty} onClick={() => void submit()}>
              Submit
            </Button>
            <Button size="small" disabled={!dirty} onClick={() => setEdits(emptyEdits())}>
              Revert
            </Button>
          </>
        )}
        {loading && <Spinner size={12} />}
      </div>
      {page && !editable && (
        <div className={styles.notice}>
          {pk.length ? "Read-only data source." : "Read-only: the table has no primary key to identify rows."}
        </div>
      )}
      {error ? (
        <pre className={styles.error}>{error}</pre>
      ) : !page ? (
        <EmptyState title="Loading…" />
      ) : (
        <div className={styles.fill}>
          <Grid
            aria-label={`${ref.table} data`}
            columns={columns.map((c) => ({
              name: c.name,
              type: c.typeName,
              primaryKey: pk.includes(c.name),
              foreignKey: fkColumns.has(c.name),
            }))}
            rowCount={rowCount}
            value={value}
            firstRowNumber={offset + 1}
            rowState={(r) => (r >= loaded ? "inserted" : edits.deletes.has(r) ? "deleted" : null)}
            isModified={(r, c) => !!edits.updates.get(r)?.has(names[c]!)}
            editable={editable}
            onEdit={onEdit}
            sort={sort}
            onSort={onSort}
            rowMenu={(rows) =>
              editable
                ? [
                    { label: "Delete Rows", icon: "trash", run: () => deleteRows(rows) },
                    {
                      label: "Restore Rows",
                      run: () =>
                        setEdits((e) => ({ ...e, deletes: new Set([...e.deletes].filter((d) => !rows.includes(d))) })),
                    },
                  ]
                : []
            }
          />
        </div>
      )}
    </div>
  );
}
