/**
 * Docker state for the Services tool window: the last snapshot, the selection,
 * and the refresh loop (a `docker events` stream while docker is up, a slow poll
 * while it is not, so the view recovers when the daemon starts).
 */
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import type { ComposeOp, ContainerOp, DockerEvent, DockerObject, DockerSnapshot, PruneTarget, RequestId } from "@/platform/ipc";
import { call, commands, isCancelled, isTauri, nextRequestId } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { findNode, type ServiceNode } from "./model";

export type DetailTab = "log" | "inspect";

interface ServicesState {
  snapshot: DockerSnapshot | null;
  loading: boolean;
  error: string | null;
  selectedKey: string | null;
  expanded: Set<string>;
  detailTab: DetailTab;
  /** Long operation in progress (pull, prune, compose…): its title and last output line. */
  task: { title: string; line: string; request: RequestId } | null;
}

export const useServices = create<ServicesState>(() => ({
  snapshot: null,
  loading: false,
  error: null,
  selectedKey: null,
  expanded: new Set(["docker", "group:containers"]),
  detailTab: "log",
  task: null,
}));

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

let inflight: Promise<void> | null = null;
let again = false;

/** Re-reads everything; concurrent calls coalesce into one follow-up refresh. */
export function refresh(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (inflight) {
    again = true;
    return inflight;
  }
  useServices.setState({ loading: true });
  inflight = call(commands.dockerSnapshot())
    .then((snapshot) => {
      const wasReady = useServices.getState().snapshot?.availability.kind === "ready";
      useServices.setState({ snapshot, error: null });
      if (snapshot.availability.kind === "ready" && !wasReady) startEvents();
    })
    .catch((e) => useServices.setState({ error: errorMessage(e) }))
    .finally(() => {
      inflight = null;
      useServices.setState({ loading: false });
      if (again) {
        again = false;
        void refresh();
      }
    });
  return inflight;
}

let debounce: ReturnType<typeof setTimeout> | undefined;
function refreshSoon() {
  clearTimeout(debounce);
  debounce = setTimeout(() => void refresh(), 250);
}

let eventsRequest: RequestId | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let watchers = 0;

function startEvents() {
  if (eventsRequest !== null || watchers === 0) return;
  const request = nextRequestId();
  eventsRequest = request;
  const channel = new Channel<DockerEvent>();
  channel.onmessage = () => refreshSoon();
  void call(commands.dockerEvents(request, channel))
    .catch(() => undefined)
    .finally(() => {
      if (eventsRequest !== request) return;
      eventsRequest = null;
      // The stream ended on its own (daemon stopped): re-check the state.
      if (watchers > 0) refreshSoon();
    });
}

function stopEvents() {
  if (eventsRequest !== null) {
    const r = eventsRequest;
    eventsRequest = null;
    void commands.cancelRequest(r);
  }
}

/**
 * Keeps the snapshot live while the view is shown: events while docker runs,
 * a poll every 10 s while it does not (or the events stream is down).
 */
export function watch(): () => void {
  watchers++;
  void refresh().then(() => {
    if (useServices.getState().snapshot?.availability.kind === "ready") startEvents();
  });
  if (watchers === 1) {
    pollTimer = setInterval(() => {
      const ready = useServices.getState().snapshot?.availability.kind === "ready";
      if (!ready || eventsRequest === null) void refresh();
    }, 10_000);
  }
  return () => {
    watchers--;
    if (watchers === 0) {
      clearInterval(pollTimer);
      stopEvents();
    }
  };
}

export function selectedNode(): ServiceNode | null {
  const { snapshot, selectedKey } = useServices.getState();
  return findNode(snapshot, selectedKey);
}

async function guarded(title: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({ group: "run", level: "error", title, body: errorMessage(e), key: "docker-op" });
    return false;
  } finally {
    refreshSoon();
  }
}

export function containerOp(ids: string[], op: ContainerOp): Promise<boolean> {
  const verb = { start: "start", stop: "stop", restart: "restart", pause: "pause", unpause: "unpause", kill: "kill" }[op];
  return guarded(`Could not ${verb} container`, () => call(commands.dockerContainerOp(ids, op)));
}

export function removeObjects(object: DockerObject, ids: string[], force: boolean): Promise<boolean> {
  return guarded(`Could not remove ${object}`, () => call(commands.dockerRemove(object, ids, force)));
}

/** Runs a streaming operation, showing its latest output line in the view's banner. */
async function task(title: string, run: (request: RequestId, out: Channel<string>) => Promise<unknown>): Promise<boolean> {
  if (useServices.getState().task) {
    notifications().notify({ group: "run", level: "info", title: "Another Docker operation is still running", key: "docker-op" });
    return false;
  }
  const request = nextRequestId();
  const out = new Channel<string>();
  let last = "";
  out.onmessage = (line) => {
    last = line;
    useServices.setState((s) => (s.task ? { task: { ...s.task, line } } : s));
  };
  useServices.setState({ task: { title, line: "", request } });
  try {
    return await guarded(title.replace(/…$/, "") + " failed", () => run(request, out));
  } finally {
    useServices.setState({ task: null });
    if (last) notifications().notify({ group: "run", level: "info", title: title.replace(/…$/, ""), body: last, key: "docker-task" });
  }
}

export function cancelTask() {
  const t = useServices.getState().task;
  if (t) void commands.cancelRequest(t.request);
}

export const pullImage = (reference: string) =>
  task(`Pulling ${reference}…`, (r, out) => call(commands.dockerPull(r, reference, out)));

export const prune = (target: PruneTarget) =>
  task(`Pruning ${target === "allImages" ? "unused images" : target}…`, (r, out) => call(commands.dockerPrune(r, target, out)));

export function composeOp(project: string, files: string[], workingDir: string | null, op: ComposeOp) {
  return task(`Compose ${op} ${project}…`, (r, out) => call(commands.dockerComposeOp(r, project, files, workingDir, op, out)));
}
