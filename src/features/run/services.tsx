/**
 * Run configurations in the Services tool window (IDEA's Run Dashboard): the
 * configuration types added there ("Add Service › Run Configuration Type") and
 * the types of this window's run sessions, one group each, with run / stop /
 * rerun / show output per configuration.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useT, useTxTemplate } from "@/platform/i18n";
import { Button, EmptyState, T } from "@/ui";
import type { MenuItem } from "@/ui";
import {
  toolWindowService,
  type ServiceItemAction,
  type ServiceProviderContribution,
  type ServiceTreeItem,
} from "@/workbench/contributions";
import { commandLine, configIcon, KIND_OPTIONS, kindLabel } from "./configs";
import { rerunSession, stopSession, useRun, type RunSession } from "./store";
import styles from "./RunServices.module.css";

export const RUN_PROVIDER = "runConfigurations";
const TYPE_PREFIX = "run:type:";
const CONFIG_PREFIX = "run:config:";
const STORAGE_KEY = "openidea.services.runTypes:";

// ---------------------------------------------------------------------------
// Types added to Services, per project

const useAddedTypes = create<{ root: string | null; types: string[] }>(() => ({ root: null, types: [] }));

function readTypes(root: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY + root) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function addedTypes(root: string | null): string[] {
  const s = useAddedTypes.getState();
  return s.root === root ? s.types : root ? readTypes(root) : [];
}

function setAddedTypes(types: string[]) {
  const root = useProject.getState().project?.root ?? null;
  useAddedTypes.setState({ root, types });
  if (!root) return;
  try {
    localStorage.setItem(STORAGE_KEY + root, JSON.stringify(types));
  } catch {
    /* storage unavailable */
  }
}

export function addType(kind: string) {
  const types = addedTypes(useProject.getState().project?.root ?? null);
  if (!types.includes(kind)) setAddedTypes([...types, kind]);
}

export function removeType(kind: string) {
  setAddedTypes(addedTypes(useProject.getState().project?.root ?? null).filter((t) => t !== kind));
}

// ---------------------------------------------------------------------------
// Tree

const busy = (s: RunSession) => s.status === "running" || s.status === "starting";

/** The newest session of each configuration id. */
function latestSessions(sessions: readonly RunSession[]): Map<string, RunSession> {
  const out = new Map<string, RunSession>();
  for (const s of sessions) {
    const prev = out.get(s.config.id);
    if (!prev || s.startedAt >= prev.startedAt) out.set(s.config.id, s);
  }
  return out;
}

export function sessionStatus(s: RunSession | undefined): string | undefined {
  if (!s) return undefined;
  if (busy(s)) return s.status === "starting" ? "Starting" : "Running";
  if (s.stopped) return "Stopped";
  if (s.status === "failed") return s.exitCode === null ? "Failed" : `Failed (exit ${s.exitCode})`;
  return "Finished";
}

/** Groups by configuration type: added types list all their configurations, other types only those that ran. */
export function runServiceItems(
  configs: readonly RunConfig[],
  sessions: readonly RunSession[],
  added: readonly string[],
): ServiceTreeItem[] {
  const latest = latestSessions(sessions);
  const kinds = [...added];
  for (const s of sessions) if (!kinds.includes(s.config.kind)) kinds.push(s.config.kind);
  return kinds.map((kind) => {
    const entries: RunConfig[] = added.includes(kind) ? configs.filter((c) => c.kind === kind) : [];
    for (const s of latest.values())
      if (s.config.kind === kind && !entries.some((c) => c.id === s.config.id)) entries.push(s.config);
    const children = entries.map((c): ServiceTreeItem => {
      const s = latest.get(c.id);
      return {
        key: CONFIG_PREFIX + c.id,
        label: c.name,
        icon: s && busy(s) ? "run" : configIcon(c),
        detail: sessionStatus(s),
        dim: !s || !busy(s),
      };
    });
    const running = entries.filter((c) => {
      const s = latest.get(c.id);
      return !!s && busy(s);
    }).length;
    return {
      key: TYPE_PREFIX + kind,
      label: kindLabel(kind),
      icon: configIcon({ kind, isTest: false }),
      detail: running ? `${running} running` : undefined,
      children,
    };
  });
}

function useRoots(): ServiceTreeItem[] {
  const root = useProject((s) => s.project?.root ?? null);
  const configs = useRun((s) => s.configs);
  const sessions = useRun((s) => s.sessions);
  const types = useAddedTypes((s) => s.types);
  const typesRoot = useAddedTypes((s) => s.root);
  useEffect(() => {
    if (typesRoot !== root) useAddedTypes.setState({ root, types: root ? readTypes(root) : [] });
  }, [root, typesRoot]);
  return useMemo(
    () => runServiceItems(configs, sessions, typesRoot === root ? types : []),
    [configs, sessions, types, typesRoot, root],
  );
}

interface Resolved {
  kind: string | null;
  config: RunConfig | null;
  session: RunSession | undefined;
  /** Sessions of a group's configurations. */
  sessions: RunSession[];
}

function resolve(item: ServiceTreeItem): Resolved {
  const { configs, sessions } = useRun.getState();
  const latest = latestSessions(sessions);
  if (item.key.startsWith(TYPE_PREFIX)) {
    const kind = item.key.slice(TYPE_PREFIX.length);
    return { kind, config: null, session: undefined, sessions: sessions.filter((s) => s.config.kind === kind) };
  }
  const id = item.key.slice(CONFIG_PREFIX.length);
  const session = latest.get(id);
  const config = configs.find((c) => c.id === id) ?? session?.config ?? null;
  return { kind: config?.kind ?? null, config, session, sessions: session ? [session] : [] };
}

function showOutput(s: RunSession) {
  useRun.setState({ activeSession: s.id });
  toolWindowService().show("run", true);
}

function run(r: Resolved) {
  if (r.session && r.session.config.id === r.config?.id) rerunSession(r.session.id);
  else if (r.config) void executeAction("run.runConfig", r.config);
}

function actions(item: ServiceTreeItem): ServiceItemAction[] {
  const r = resolve(item);
  const running = r.sessions.filter(busy);
  const stop = {
    id: "stop",
    title: "Stop",
    icon: "stop",
    disabled: !running.length,
    run: () => running.forEach((s) => void stopSession(s.id)),
  };
  if (!r.config) return [stop];
  const live = !!r.session && busy(r.session);
  return [
    { id: "run", title: live ? "Rerun" : "Run", icon: live ? "rerun" : "run", run: () => run(r) },
    stop,
    {
      id: "output",
      title: "Show Output",
      icon: "toolwindow-run",
      disabled: !r.session,
      run: () => r.session && showOutput(r.session),
    },
  ];
}

function menu(item: ServiceTreeItem): MenuItem[] {
  const items: MenuItem[] = actions(item).map((a) => ({
    label: a.title,
    icon: a.icon,
    disabled: a.disabled,
    run: a.run,
  }));
  const r = resolve(item);
  if (!r.config && r.kind && addedTypes(useProject.getState().project?.root ?? null).includes(r.kind)) {
    const kind = r.kind;
    items.push({ kind: "separator" }, { label: "Remove from Services", icon: "close", run: () => removeType(kind) });
  }
  if (r.config) {
    const config = r.config;
    items.push(
      { kind: "separator" },
      { label: "Edit Configuration…", icon: "edit", run: () => void executeAction("run.editConfigs", config.id) },
    );
  }
  return items;
}

function RunDetail({ item }: { item: ServiceTreeItem }) {
  // Re-render on session changes.
  useRun((s) => s.sessions);
  const t = useT();
  const txTemplate = useTxTemplate();
  const r = resolve(item);
  if (!r.config)
    return (
      <EmptyState title={kindLabel(r.kind ?? "")}>
        <div>
          {item.children?.length
            ? t("run.services.configurationCount", { count: item.children.length })
            : txTemplate("No configurations of this type")}
        </div>
      </EmptyState>
    );
  const s = r.session;
  const live = !!s && busy(s);
  return (
    <div className={styles.detail}>
      <dl className={styles.facts}>
        <dt>
          <T>Configuration</T>
        </dt>
        <dd>{r.config.name}</dd>
        <dt>
          <T>Type</T>
        </dt>
        <dd>
          <T>{kindLabel(r.config.kind)}</T>
        </dd>
        <dt>
          <T>Command</T>
        </dt>
        <dd className={styles.mono}>{commandLine(r.config)}</dd>
        <dt>
          <T>Status</T>
        </dt>
        <dd>{txTemplate(sessionStatus(s) ?? "Not started")}</dd>
        {s && (
          <>
            <dt>
              <T>Started</T>
            </dt>
            <dd>{new Date(s.startedAt).toLocaleTimeString()}</dd>
          </>
        )}
      </dl>
      <div className={styles.actions}>
        <Button icon={live ? "rerun" : "run"} onClick={() => run(r)}>
          {live ? "Rerun" : "Run"}
        </Button>
        <Button icon="stop" disabled={!live} onClick={() => s && void stopSession(s.id)}>
          Stop
        </Button>
        <Button icon="toolwindow-run" disabled={!s} onClick={() => s && showOutput(s)}>
          Show Output
        </Button>
      </div>
    </div>
  );
}

/** "Add Service › Run Configuration Type": the project's types first, then the rest. */
function addMenu(): MenuItem[] {
  const added = addedTypes(useProject.getState().project?.root ?? null);
  const used = [...new Set(useRun.getState().configs.map((c) => c.kind))];
  const kinds = [...used, ...KIND_OPTIONS.map((o) => o.value).filter((k) => !used.includes(k))].filter(
    (k) => !added.includes(k),
  );
  const item = (kind: string): MenuItem => ({
    label: kindLabel(kind),
    icon: configIcon({ kind, isTest: false }),
    run: () => addType(kind),
  });
  const submenu: MenuItem[] = [
    ...kinds.filter((k) => used.includes(k)).map(item),
    ...(used.some((k) => kinds.includes(k)) ? [{ kind: "separator" } as MenuItem] : []),
    ...kinds.filter((k) => !used.includes(k)).map(item),
  ];
  return [{ label: "Run Configuration Type", icon: "toolwindow-run", disabled: !submenu.length, submenu }];
}

export const runServiceProvider: ServiceProviderContribution = {
  id: RUN_PROVIDER,
  order: 0,
  useRoots,
  actions,
  menu,
  activate: (item) => {
    const r = resolve(item);
    if (r.session) showOutput(r.session);
    else if (r.config) run(r);
  },
  detail: RunDetail,
  addMenu,
};
