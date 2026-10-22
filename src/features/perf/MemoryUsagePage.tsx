/**
 * Settings › Memory Usage: memory of OpenIDEA, its language servers and other
 * processes, subsystem sizes, "Clear caches" and the status bar indicator toggle.
 */
import { useEffect, type ReactNode } from "react";
import clsx from "clsx";
import { Button, Checkbox } from "@/ui";
import { executeAction } from "@/platform/actions";
import { isTauri } from "@/platform/ipc";
import { isStatusItemVisible, setStatusWidgetVisible, useStatusWidgetOverrides } from "@/workbench/statusBarWidgets";
import { formatBytes, formatCount, formatMs, formatSize, formatUptime, memoryRatio } from "./format";
import { memorySections, summarizeMemory } from "./memory";
import { MEMORY_WIDGET } from "./MemoryStatus";
import { startPolling } from "./poll";
import { refreshMetrics, usePerf } from "./store";
import styles from "./MemoryUsage.module.css";

function Row({
  label,
  value,
  strong,
  indented,
}: {
  label: string;
  value: string;
  strong?: boolean;
  indented?: boolean;
}) {
  return (
    <div className={clsx(styles.row, strong && styles.strong, indented && styles.indented)}>
      <span className={styles.label}>{label}:</span>
      <span className={styles.value}>{value}</span>
    </div>
  );
}

/** The same setting as the status bar context menu's "Memory Indicator". */
function IndicatorToggle() {
  const overrides = useStatusWidgetOverrides();
  const shown = isStatusItemVisible(MEMORY_WIDGET, overrides);
  return (
    <Checkbox
      checked={shown}
      onChange={(on) => void setStatusWidgetVisible(MEMORY_WIDGET.id, on)}
      label="Show memory indicator in the status bar"
    />
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <div className={styles.title}>
        {title}
        <span className={styles.rule} aria-hidden />
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  );
}

export function MemoryUsagePage() {
  const m = usePerf((s) => s.metrics);
  const error = usePerf((s) => s.error);
  useEffect(() => {
    if (!isTauri()) return;
    return startPolling(() => void refreshMetrics(), { intervalMs: 2000 });
  }, []);

  if (!isTauri()) return <div className={styles.empty}>Memory usage is available in the desktop app.</div>;
  if (!m) return <div className={styles.empty}>Loading…</div>;
  const summary = summarizeMemory(m);
  const own = (summary.app ?? 0) + (summary.languageServers ?? 0);
  const ratio = memoryRatio(own, m.totalMemoryBytes);
  return (
    <div className={styles.page}>
      <Section title="Memory">
        <IndicatorToggle />
        <div
          className={styles.meter}
          role="meter"
          aria-label="OpenIDEA and language servers, share of physical memory"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className={styles.fill} style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 1 : 0)}%` }} />
        </div>
        <div className={styles.hint}>
          OpenIDEA and its language servers use {formatSize(own)} ({Math.round(ratio * 100)}%) of{" "}
          {formatSize(m.totalMemoryBytes)} physical memory.
        </div>
        {memorySections(m.memory ?? []).map((sec) => (
          <div key={sec.title} className={styles.group}>
            <Row label={sec.title} value={sec.total} strong />
            {sec.rows.map((r) => (
              <Row key={r.key} label={r.detail ? `${r.label} (${r.detail})` : r.label} value={r.value} indented />
            ))}
          </div>
        ))}
        <Row label="Total" value={formatSize(summary.total)} strong />
        {m.heapBytes != null && <Row label="Backend malloc in use" value={formatBytes(m.heapBytes)} />}
        <div className={styles.hint}>
          Memory as the OS reports it (macOS: Activity Monitor’s “Memory”; Linux: PSS; Windows: private bytes),
          including child processes.
        </div>
      </Section>
      <Section title="Caches">
        <Row label="Open projects" value={formatCount(m.projects)} />
        <Row label="Open documents" value={formatCount(m.openDocuments)} />
        <Row
          label={m.indexing ? "Index (indexing…)" : "Index"}
          value={`${formatCount(m.indexFiles)} files · ${formatCount(m.indexSymbols)} symbols`}
        />
        <Row label="Language servers" value={formatCount(m.languageServers)} />
        <Row
          label="Syntax trees"
          value={`${m.syntax.trees} / ${m.syntax.documents} documents · ${formatBytes(m.syntax.treeTextBytes)}`}
        />
        <div className={styles.actions}>
          <Button icon="trash" onClick={() => void executeAction("perf.clearCaches")}>
            Clear Caches
          </Button>
          <span className={styles.hint}>
            Drops syntax trees and EditorConfig data and compacts the index; they are rebuilt on demand.
          </span>
        </div>
      </Section>
      <Section title="Startup">
        <Row label="Uptime" value={formatUptime(m.uptimeMs)} />
        <Row label="Process → main" value={formatMs(m.startup.processToMainMs)} />
        <Row label="Process → backend ready" value={formatMs(m.startup.processToSetupMs)} />
        <Row label="Backend set-up" value={formatMs(m.startup.setupMs)} />
        <Row label="Process → first IPC" value={formatMs(m.startup.firstIpcMs)} />
        <div className={styles.hint}>
          “Process → main” is spent before any OpenIDEA code runs: exec, code-signature checks and dynamic loading. macOS
          scans a freshly built, unsigned debug binary for several seconds on its first launch.
        </div>
      </Section>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
