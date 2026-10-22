import { useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { HighlightedText, Icon, IconButton, List, Popup, SearchField, fuzzyMatch, listNavigate } from "@/ui";
import type { RunConfig } from "@/platform/ipc";
import { commandLine, configIcon, groupConfigs } from "./configs";
import { saveTemporary, selectConfig, startRun, useRun } from "./store";
import styles from "./Run.module.css";

type Row =
  | { type: "section"; key: string; label: string }
  | { type: "config"; key: string; config: RunConfig; indices: number[] | null }
  | { type: "edit"; key: string }
  | { type: "save"; key: string; config: RunConfig };

const ROW = 24;

export function buildRows(
  configs: readonly RunConfig[],
  query: string,
  selected?: RunConfig | null,
  temporary: readonly string[] = [],
): Row[] {
  const rows: Row[] = [];
  // IDEA: "Save '<name>' Configuration" first while a temporary configuration is selected.
  if (!query && selected && temporary.includes(selected.id)) rows.push({ type: "save", key: "save", config: selected });
  for (const group of groupConfigs(configs)) {
    const matched = group.configs
      .map((c) => ({ c, indices: query ? fuzzyMatch(c.name, query) : null }))
      .filter((x) => !query || x.indices);
    if (matched.length === 0) continue;
    rows.push({ type: "section", key: `s:${group.kind}`, label: group.label });
    for (const { c, indices } of matched) rows.push({ type: "config", key: `c:${c.id}`, config: c, indices });
  }
  rows.push({ type: "edit", key: "edit" });
  return rows;
}

let closedAt = 0;
/** The chooser closed within the last moment (a click on its own anchor shouldn't reopen it). */
export function chooserJustClosed(): boolean {
  return Date.now() - closedAt < 250;
}

function anchorElement(): Element | { x: number; y: number } {
  return (
    document.querySelector("[data-run-chooser]") ?? { x: Math.round(window.innerWidth / 2) - 150, y: 40 }
  );
}

/** Run/Debug configuration chooser popup (⌃⌥R), anchored to the title bar widget. */
export function ConfigChooserOverlay() {
  const open = useRun((s) => s.chooserOpen);
  if (!open) return null;
  return <ConfigChooser />;
}

function ConfigChooser() {
  const configs = useRun((s) => s.configs);
  const selectedId = useRun((s) => s.selectedId);
  const temporary = useRun((s) => s.temporary);
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => buildRows(configs, query, configs.find((c) => c.id === selectedId), temporary),
    [configs, query, selectedId, temporary],
  );
  const isSection = (r: Row) => r.type === "section";
  const initial = Math.max(
    0,
    rows.findIndex((r) => r.type === "config" && r.config.id === selectedId),
  );
  const [active, setActive] = useState(initial);
  const [anchor] = useState(anchorElement);
  const close = () => {
    closedAt = Date.now();
    useRun.setState({ chooserOpen: false });
  };
  const clamped = Math.min(active, rows.length - 1);

  const activate = (row: Row | undefined, mode: "select" | "run" | "debug" = "select") => {
    if (!row) return;
    close();
    if (row.type === "edit") {
      void executeAction("run.editConfigs");
      return;
    }
    if (row.type === "save") {
      void saveTemporary(row.config.id);
      return;
    }
    if (row.type !== "config") return;
    selectConfig(row.config.id);
    if (mode === "run") void startRun(row.config);
    if (mode === "debug") void executeAction("run.debug");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      activate(rows[clamped], e.shiftKey ? "debug" : e.altKey || e.metaKey ? "run" : "select");
      return;
    }
    const next = listNavigate(e.key, { items: rows, active: clamped, isSection, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  const height = Math.min(rows.length * ROW, 14 * ROW);

  return (
    <Popup
      open
      anchor={anchor}
      onClose={close}
      placement="bottom-start"
      aria-label="Run/Debug Configurations"
      className={styles.chooser}
      trapFocus
    >
      <div className={styles.chooserSearch}>
        <SearchField
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(1);
          }}
          placeholder="Search configurations"
          aria-label="Search configurations"
          data-autofocus=""
          onKeyDown={onKeyDown}
          variant="bare"
        />
      </div>
      <div style={{ height }}>
        <List<Row>
          aria-label="Configurations"
          className={styles.chooserList}
          items={rows}
          getKey={(r) => r.key}
          isSection={isSection}
          renderSection={(r) => (r.type === "section" ? r.label : null)}
          activeIndex={clamped}
          onActiveChange={setActive}
          focusable={false}
          hoverSelects
          rowHeight={ROW}
          onActivate={(r) => activate(r)}
          renderItem={(r, { active: isActive }) => {
            if (r.type === "save") {
              return (
                <span className={clsx(styles.chooserRow, styles.chooserEdit)}>
                  <Icon name="check" size={13} />
                  <span>Save &apos;{r.config.name}&apos; Configuration</span>
                </span>
              );
            }
            if (r.type === "edit") {
              return (
                <span className={clsx(styles.chooserRow, styles.chooserEdit)}>
                  <Icon name="edit" size={13} />
                  <span>Edit Configurations…</span>
                  <span className={styles.chooserShortcut}>{shortcutLabel("run.editConfigs")}</span>
                </span>
              );
            }
            if (r.type !== "config") return null;
            const c = r.config;
            return (
              <span className={styles.chooserRow} title={commandLine(c)}>
                <Icon
                  name={configIcon(c)}
                  size={13}
                  className={clsx(styles.chooserIcon, temporary.includes(c.id) && styles.chooserTemporary)}
                />
                <span className={clsx(styles.chooserName, c.id === selectedId && styles.chooserSelected)}>
                  {r.indices ? <HighlightedText text={c.name} indices={r.indices} /> : c.name}
                </span>
                {c.isTest && <span className={styles.badge}>test</span>}
                {!c.detected && <span className={styles.chooserMuted}>user</span>}
                {temporary.includes(c.id) && <span className={styles.chooserMuted}>temporary</span>}
                {isActive && (
                  <span className={styles.chooserActions}>
                    <IconButton
                      icon="run"
                      size="small"
                      iconSize={11}
                      title={`Run '${c.name}'`}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        activate(r, "run");
                      }}
                    />
                    <IconButton
                      icon="debug"
                      size="small"
                      iconSize={13}
                      title={`Debug '${c.name}'`}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        activate(r, "debug");
                      }}
                    />
                  </span>
                )}
              </span>
            );
          }}
        />
      </div>
    </Popup>
  );
}
