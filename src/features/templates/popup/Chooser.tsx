import { useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { HighlightedText, List, Popup, fuzzyMatch, listNavigate } from "@/ui";
import { closeChooser, useChooser, type ChooserItem, type ChooserRequest } from "./store";
import styles from "./Chooser.module.css";

/** Overlay contribution: renders the pending chooser, if any. */
export function ChooserHost() {
  const { request, seq } = useChooser();
  if (!request) return null;
  return <ChooserPopup key={seq} request={request} />;
}

interface Row {
  item: ChooserItem;
  matches: number[] | null;
}

export function filterChooserItems(items: readonly ChooserItem[], filter: string): Row[] {
  if (!filter) return items.map((item) => ({ item, matches: null }));
  const q = filter.toLowerCase();
  const prefix: Row[] = [];
  const fuzzy: Row[] = [];
  for (const item of items) {
    if (item.label.toLowerCase().startsWith(q)) prefix.push({ item, matches: [...Array(q.length).keys()] });
    else {
      const m = fuzzyMatch(item.label, filter);
      if (m) fuzzy.push({ item, matches: m });
      else if (item.search && item.search.toLowerCase().includes(q)) fuzzy.push({ item, matches: null });
    }
  }
  return [...prefix, ...fuzzy];
}

function ChooserPopup({ request }: { request: ChooserRequest }) {
  const [filter, setFilter] = useState(request.filter ?? "");
  const [active, setActive] = useState(0);
  const rows = useMemo(() => filterChooserItems(request.items, filter), [request.items, filter]);
  const current = Math.min(active, rows.length - 1);

  const close = () => {
    closeChooser();
    request.onCancel?.();
  };
  const pick = (row: Row | undefined) => {
    if (!row) return;
    closeChooser();
    request.onPick(row.item, filter);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const next = listNavigate(e.key, { items: rows, active: current, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(rows[current]);
    } else if (request.filterable && e.key === "Backspace") {
      e.preventDefault();
      setFilter((f) => f.slice(0, -1));
      setActive(0);
    } else if (request.filterable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setFilter((f) => f + e.key);
      setActive(0);
    }
  };

  return (
    <Popup
      open
      anchor={request.anchor}
      placement="bottom-start"
      offset={2}
      onClose={close}
      role="dialog"
      aria-label={request.title}
      className={styles.popup}
    >
      <div className={styles.body} tabIndex={0} data-autofocus onKeyDown={onKeyDown}>
        <div className={styles.header}>
          <span className={styles.title}>{request.title}</span>
          {request.filterable && filter && <span className={styles.filter}>{filter}</span>}
        </div>
        <List
          items={rows}
          getKey={(r) => r.item.key}
          activeIndex={current}
          onActiveChange={setActive}
          onActivate={(r) => pick(r)}
          focusable={false}
          hoverSelects
          rowHeight={22}
          className={styles.list}
          aria-label={request.title}
          empty={<div className={styles.empty}>{request.emptyText ?? "Nothing to show"}</div>}
          renderItem={(r, state) => (
            <div className={clsx(styles.row, state.active && styles.active)}>
              <span className={styles.label}>
                <HighlightedText text={r.item.label} indices={r.matches ?? undefined} />
              </span>
              {r.item.detail && <span className={styles.detail}>{r.item.detail}</span>}
            </div>
          )}
        />
      </div>
    </Popup>
  );
}
