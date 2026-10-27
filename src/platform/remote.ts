/**
 * Remote development: in a window whose project lives on another machine, the
 * commands that machine's `openidea-server` answers are routed to it (through
 * the `remote_invoke` command) instead of running locally. Routing happens below
 * the generated bindings, so features call `commands.*` as usual.
 */
import { Channel, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { invokeLocal, setInvokeRoute, type InvokeRoute } from "./tauriCore";
import { create } from "zustand";
import { call, commands, isTauri, type ChannelFrame, type RemoteSession } from "./ipc";
import { useProject } from "./project";

interface RemoteState {
  session: RemoteSession | null;
}

export const useRemote = create<RemoteState>(() => ({ session: null }));

let routed = new Set<string>();
let nextChannel = 1;

/**
 * The arguments with each `Channel` replaced by `{ $channel: id }`, and the
 * channels by id (their values come back tagged with the id).
 */
export function encodeArgs(args: unknown): { json: string; channels: Map<number, Channel<unknown>> } {
  const channels = new Map<number, Channel<unknown>>();
  const plain: Record<string, unknown> = {};
  if (args && typeof args === "object") {
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (v instanceof Channel) {
        const id = nextChannel++;
        channels.set(id, v as Channel<unknown>);
        plain[k] = { $channel: id };
      } else {
        plain[k] = v;
      }
    }
  }
  return { json: JSON.stringify(plain), channels };
}

async function remoteInvoke(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<unknown> {
  const { json, channels } = encodeArgs(args);
  const onChannel = new Channel<ChannelFrame>();
  onChannel.onmessage = (frame) => channels.get(frame.id)?.onmessage(JSON.parse(frame.data));
  const result = await invokeLocal<string>("remote_invoke", { cmd, args: json, onChannel }, options);
  return JSON.parse(result);
}

/**
 * Where a command of a remote window runs. Local always: opening a project (a
 * local folder; leaving the remote one) and closing it (that drops the
 * connection, which ends the server's session). Both: a global setting, which
 * the server's language servers and the local windows read.
 */
export function remoteRouting(cmd: string, args: InvokeArgs | undefined, served: ReadonlySet<string>) {
  if (!served.has(cmd) || cmd === "open_project" || cmd === "close_project") return "local";
  if (cmd === "settings_set" && (args as { scope?: string } | undefined)?.scope === "global") return "both";
  return "remote";
}

const route: InvokeRoute = (cmd, args, options) => {
  switch (remoteRouting(cmd, args, routed)) {
    case "local":
      return null;
    case "remote":
      return remoteInvoke(cmd, args, options);
    case "both":
      return invokeLocal(cmd, args, options).then(() => remoteInvoke(cmd, args, options));
  }
};

/** Routes the commands the server answers (`session.commands`) to it from now on. */
export function enableRemote(session: RemoteSession) {
  routed = new Set(session.commands);
  useRemote.setState({ session });
  setInvokeRoute(route);
}

export function disableRemote() {
  routed = new Set();
  setInvokeRoute(null);
  useRemote.setState({ session: null });
}

export function isRemoteWindow(): boolean {
  return useRemote.getState().session !== null;
}

/** Re-attaches after a reload (the backend keeps the connection per window). */
export async function restoreRemote(): Promise<RemoteSession | null> {
  if (!isTauri()) return null;
  const session = await commands.remoteCurrent().catch(() => null);
  if (session) enableRemote(session);
  return session;
}

/** Opens `path` on the host of SSH configuration `sshConfig` in this window. */
export async function connectRemote(sshConfig: string, path: string) {
  useProject.setState({ opening: true });
  try {
    const r = await call(commands.remoteConnect(sshConfig, path));
    enableRemote({ sshConfig: r.sshConfig, root: r.root, host: r.host, commands: r.commands });
    useProject.setState({ project: r.project, settings: r.project.settings });
    return r;
  } finally {
    useProject.setState({ opening: false });
  }
}

export async function disconnectRemote() {
  if (!isRemoteWindow()) return;
  await commands.closeProject();
  disableRemote();
  useProject.setState({ project: null });
}

// Any way of leaving the remote project (Close Project, opening a local one) ends remote routing.
useProject.subscribe((s) => {
  const session = useRemote.getState().session;
  if (session && !s.opening && s.project?.root !== session.root) disableRemote();
});
