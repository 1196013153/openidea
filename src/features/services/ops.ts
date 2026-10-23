/** What the Services toolbar, context menu and `docker.*` actions do with a node. */
import type { PruneTarget } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { showServiceView } from "@/workbench/contributions";
import type { MenuItem } from "@/ui";
import { confirm, confirmChecked } from "@/workbench/messages";
import { promptText } from "./dialogs";
import { isRunning, nodeContainers, nodeLabel, shortId, type ServiceNode } from "./model";
import { composeOp, containerOp, prune, pullImage, refresh, removeObjects, selectedNode, useServices } from "./store";

export const DOCKER_VIEW = "docker";

export function canStart(n: ServiceNode | null): boolean {
  return !!n && nodeContainers(n).some((c) => !isRunning(c));
}
export function canStop(n: ServiceNode | null): boolean {
  return !!n && nodeContainers(n).some(isRunning);
}
export function canRemove(n: ServiceNode | null): boolean {
  return !!n && ["container", "compose", "image", "volume", "network"].includes(n.kind);
}

export async function start(n: ServiceNode | null) {
  if (!n) return;
  if (n.kind === "compose") return composeAction(n, "start");
  const ids = nodeContainers(n).filter((c) => !isRunning(c)).map((c) => c.id);
  if (ids.length) await containerOp(ids, "start");
}

export async function stop(n: ServiceNode | null) {
  if (!n) return;
  if (n.kind === "compose") return composeAction(n, "stop");
  const ids = nodeContainers(n).filter(isRunning).map((c) => c.id);
  if (ids.length) await containerOp(ids, "stop");
}

export async function restart(n: ServiceNode | null) {
  if (!n) return;
  if (n.kind === "compose") return composeAction(n, "restart");
  const ids = nodeContainers(n).map((c) => c.id);
  if (ids.length) await containerOp(ids, "restart");
}

function composeAction(n: Extract<ServiceNode, { kind: "compose" }>, op: "start" | "stop" | "restart" | "down") {
  const first = n.containers[0];
  return composeOp(n.project, first?.composeFiles ?? [], first?.composeWorkingDir ?? null, op).then(() => undefined);
}

export async function remove(n: ServiceNode | null) {
  if (!n || !canRemove(n)) return;
  const label = nodeLabel(n);
  if (n.kind === "compose") {
    const ok = await confirm({
      title: "Compose Down",
      message: `Stop and remove the containers and networks of '${label}'?`,
      ok: "Down",
    });
    if (ok) await composeAction(n, "down");
    return;
  }
  if (n.kind !== "container" && n.kind !== "image" && n.kind !== "volume" && n.kind !== "network") return;
  const what = n.kind;
  const running = n.kind === "container" && isRunning(n.container);
  const answer = await confirmChecked({
    title: `Delete ${what[0]!.toUpperCase()}${what.slice(1)}`,
    message: `Delete ${what} '${label}'?${running ? " It is running and will be stopped." : ""}`,
    ok: "Delete",
    checkbox: n.kind === "image" ? "Force (also untag / remove when used by stopped containers)" : undefined,
  });
  if (!answer) return;
  const id = n.kind === "container" ? n.container.id : n.kind === "image" ? n.image.id : n.kind === "volume" ? n.volume.name : n.network.id;
  await removeObjects(what, [id], running || answer.checked);
}

/** Opens a terminal tab with a shell in the container (bash when present, else sh). */
export function execShell(n: ServiceNode | null) {
  const c = n?.kind === "container" ? n.container : null;
  if (!c || !isRunning(c)) return;
  const docker = useServices.getState().snapshot?.executable ?? "docker";
  void executeAction("terminal.runCommand", {
    program: docker,
    args: ["exec", "-it", c.id, "sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"],
    name: c.name,
  });
}

export function showDetail(tab: "log" | "inspect") {
  useServices.setState({ detailTab: tab });
  showServiceView(DOCKER_VIEW, true);
}

export async function pullPrompt() {
  const ref = await promptText("Pull Image", "Image to pull:", "e.g. postgres:16 or ghcr.io/org/app:latest");
  if (ref) await pullImage(ref);
}

const PRUNE: Array<[PruneTarget, string, string]> = [
  ["containers", "Stopped Containers", "Remove all stopped containers?"],
  ["images", "Dangling Images", "Remove all dangling (untagged) images?"],
  ["allImages", "Unused Images", "Remove all images not used by a container?"],
  ["volumes", "Unused Volumes", "Remove all anonymous volumes not used by a container? Their data is lost."],
  ["networks", "Unused Networks", "Remove all networks not used by a container?"],
  ["system", "Everything Unused (System Prune)", "Remove stopped containers, unused networks, dangling images and the build cache?"],
];

export async function prunePrompt(target: PruneTarget) {
  const entry = PRUNE.find(([t]) => t === target);
  if (!entry) return;
  const ok = await confirm({ title: `Prune ${entry[1]}`, message: entry[2], ok: "Prune" });
  if (ok) await prune(target);
}

export function pruneMenu(): MenuItem[] {
  return PRUNE.map(([target, label]) => ({ label, run: () => void prunePrompt(target) }));
}

const copy = (text: string) => void navigator.clipboard?.writeText(text);

/** Context menu of a tree node. */
export function nodeMenu(n: ServiceNode): MenuItem[] {
  const items: MenuItem[] = [];
  if (n.kind === "container" || n.kind === "compose") {
    items.push(
      { label: "Start", icon: "run", disabled: !canStart(n), run: () => void start(n) },
      { label: "Stop", icon: "stop", disabled: !canStop(n), run: () => void stop(n) },
      { label: "Restart", icon: "rerun", run: () => void restart(n) },
    );
  }
  if (n.kind === "container") {
    const running = isRunning(n.container);
    items.push(
      n.container.state === "paused"
        ? { label: "Unpause", icon: "resume", run: () => void containerOp([n.container.id], "unpause") }
        : { label: "Pause", icon: "pause", disabled: !running, run: () => void containerOp([n.container.id], "pause") },
      { kind: "separator" },
      { label: "Show Log", icon: "file-log", run: () => showDetail("log") },
      { label: "Inspect", icon: "info", run: () => showDetail("inspect") },
      { label: "Create Terminal", icon: "terminal", disabled: !running, run: () => execShell(n) },
      { kind: "separator" },
      { label: "Copy Container ID", icon: "copy", run: () => copy(n.container.id) },
      { label: "Copy Image Name", run: () => copy(n.container.image) },
    );
  }
  if (n.kind === "image" || n.kind === "volume" || n.kind === "network") {
    items.push({ label: "Inspect", icon: "info", run: () => showDetail("inspect") });
    if (n.kind === "image")
      items.push(
        { label: "Pull Again", icon: "git-pull", disabled: n.image.repository === "<none>", run: () => void pullImage(nodeLabel(n)) },
        { label: "Copy Image ID", icon: "copy", run: () => copy(shortId(n.image.id)) },
      );
  }
  if (n.kind === "group" && n.group === "images") items.push({ label: "Pull Image…", icon: "git-pull", run: () => void pullPrompt() });
  if (n.kind === "group") {
    const target: PruneTarget = n.group === "containers" ? "containers" : n.group === "images" ? "images" : n.group === "volumes" ? "volumes" : "networks";
    items.push({ label: `Prune ${n.group === "images" ? "Dangling Images" : `Unused ${n.group[0]!.toUpperCase()}${n.group.slice(1)}`}…`, run: () => void prunePrompt(target) });
  }
  if (n.kind === "docker") items.push({ label: "Refresh", icon: "refresh", run: () => void refresh() }, { label: "Prune", submenu: pruneMenu() });
  if (canRemove(n)) {
    items.push({ kind: "separator" }, { label: n.kind === "compose" ? "Compose Down" : "Delete…", icon: "trash", danger: true, run: () => void remove(n) });
  }
  return items;
}

export const selected = selectedNode;
