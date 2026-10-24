/**
 * Tool installer backend: `tools_*` IPC in the desktop app; an in-memory
 * simulation in plain-browser development and tests (no network, ever).
 */
import { Channel } from "@tauri-apps/api/core";
import type { InstallEvent, RequestId, ToolInfo } from "@/bindings";
import { call, commands, IpcError, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";

export interface ToolsBackend {
  list(): Promise<ToolInfo[]>;
  install(name: string, request: RequestId, onEvent: (e: InstallEvent) => void): Promise<ToolInfo>;
  uninstall(name: string): Promise<ToolInfo>;
  cancel(request: RequestId): void;
  /** Restarts running language servers named `name` (after an install). */
  restartServers(name: string): Promise<void>;
  /** Launches `command` from `path` instead of the detected one (global setting); "" clears it. */
  setCustomPath(command: string, path: string): Promise<void>;
  /** File chooser for an executable; null when cancelled. */
  chooseExecutable(title: string, defaultPath?: string): Promise<string | null>;
}

export const tauriToolsBackend: ToolsBackend = {
  list: () => call(commands.toolsList()),
  install: (name, request, onEvent) => {
    const channel = new Channel<InstallEvent>();
    channel.onmessage = onEvent;
    return call(commands.toolsInstall(name, request, channel));
  },
  uninstall: (name) => call(commands.toolsUninstall(name)),
  cancel: (request) => void commands.cancelRequest(request).catch(() => {}),
  restartServers: async (name) => {
    let servers;
    try {
      servers = await call(commands.lspServers());
    } catch {
      return; // no project open
    }
    await Promise.all(
      servers.filter((s) => s.name === name).map((s) => call(commands.lspRestart(s.id)).catch(() => {})),
    );
  },
  setCustomPath: async (command, path) => {
    const tools = { ...(await commands.settingsGet()).tools };
    if (path) tools[command] = { path };
    else delete tools[command];
    const settings = await call(commands.settingsSet("global", "tools", JSON.stringify(tools)));
    useProject.setState({ settings });
  },
  chooseExecutable: async (title, defaultPath) => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: false, multiple: false, title, defaultPath: defaultPath || undefined });
    return (Array.isArray(picked) ? picked[0] : picked) ?? null;
  },
};

function tool(partial: Partial<ToolInfo> & Pick<ToolInfo, "name" | "languages">): ToolInfo {
  return {
    displayName: partial.name,
    kind: "languageServer",
    command: partial.name,
    status: "missing",
    path: null,
    version: null,
    installMethod: "npm",
    canInstall: true,
    unavailableReason: null,
    canUninstall: false,
    installHint: null,
    homepage: null,
    customError: null,
    ...partial,
  };
}

export function sampleTools(): ToolInfo[] {
  return [
    tool({
      name: "rust-analyzer",
      languages: ["Rust"],
      installMethod: "rustup",
      status: "installed",
      version: "1.85.0",
      path: "~/.cargo/bin/rust-analyzer",
      canUninstall: true,
    }),
    tool({ name: "vtsls", displayName: "vtsls (TypeScript)", languages: ["TypeScript", "JavaScript"] }),
    tool({
      name: "typescript-language-server",
      languages: ["TypeScript", "JavaScript"],
      status: "onPath",
      version: "4.3.3",
      path: "/opt/homebrew/bin/typescript-language-server",
    }),
    tool({ name: "basedpyright", languages: ["Python"], installMethod: "pip (virtualenv)" }),
    tool({ name: "gopls", languages: ["Go"], installMethod: "go install" }),
    tool({
      name: "delve",
      displayName: "Delve (Go debugger)",
      kind: "debugger",
      command: "dlv",
      languages: ["Go"],
      installMethod: "go install",
    }),
    tool({
      name: "codelldb",
      displayName: "CodeLLDB",
      kind: "debugger",
      languages: ["Rust", "C", "C++"],
      installMethod: "GitHub release",
    }),
    tool({
      name: "kotlin-lsp",
      displayName: "Kotlin LSP (JetBrains)",
      languages: ["Kotlin"],
      installMethod: "GitHub release",
    }),
    tool({
      name: "zls",
      displayName: "ZLS (Zig)",
      languages: ["Zig"],
      installMethod: "GitHub release",
      canInstall: false,
      unavailableReason: "curl is required to download tools",
    }),
    tool({
      name: "solargraph",
      languages: ["Ruby"],
      installMethod: null,
      canInstall: false,
      installHint: "gem install solargraph",
    }),
  ];
}

/** Deterministic in-memory installer: emits a few lines + progress, then flips the status. */
export class MemoryToolsBackend implements ToolsBackend {
  tools: ToolInfo[];
  restarted: string[] = [];
  /** Delay between simulated steps (ms). */
  stepMs: number;
  failNext: string | null = null;
  private cancelled = new Set<RequestId>();

  constructor(tools: ToolInfo[] = sampleTools(), stepMs = 120) {
    this.tools = tools;
    this.stepMs = stepMs;
  }

  async list() {
    return this.tools.map((t) => ({ ...t }));
  }

  private replace(next: ToolInfo) {
    this.tools = this.tools.map((t) => (t.name === next.name ? next : t));
    return { ...next };
  }

  private wait() {
    return new Promise<void>((r) => setTimeout(r, this.stepMs));
  }

  async install(name: string, request: RequestId, onEvent: (e: InstallEvent) => void) {
    const t = this.tools.find((x) => x.name === name);
    if (!t) throw new IpcError({ kind: "notFound", message: `unknown tool \`${name}\`` });
    if (!t.canInstall)
      throw new IpcError({
        kind: "unavailable",
        message: t.unavailableReason ?? `${name} cannot be installed automatically`,
      });
    onEvent({ type: "line", text: `Installing ${t.displayName} via ${t.installMethod}…` });
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      await this.wait();
      if (this.cancelled.delete(request)) throw new IpcError({ kind: "cancelled", message: "cancelled" });
      onEvent({ type: "progress", fraction, message: `Downloaded ${(fraction * 8).toFixed(1)} of 8.0 MB` });
    }
    if (this.failNext === name) {
      this.failNext = null;
      throw new IpcError({ kind: "io", message: `installer for ${name} failed` });
    }
    onEvent({ type: "line", text: `${t.displayName} 1.0.0 installed` });
    return this.replace({
      ...t,
      status: "installed",
      version: "1.0.0",
      path: `~/tools/${name}/bin/${t.command}`,
      canUninstall: true,
    });
  }

  async uninstall(name: string) {
    const t = this.tools.find((x) => x.name === name);
    if (!t) throw new IpcError({ kind: "notFound", message: `unknown tool \`${name}\`` });
    return this.replace({ ...t, status: "missing", version: null, path: null, canUninstall: false });
  }

  cancel(request: RequestId) {
    this.cancelled.add(request);
  }

  async restartServers(name: string) {
    this.restarted.push(name);
  }

  /** Paths set through `setCustomPath`, by command. */
  customPaths: Record<string, string> = {};
  /** What `chooseExecutable` answers. */
  chosen: string | null = null;

  async setCustomPath(command: string, path: string) {
    if (path) this.customPaths[command] = path;
    else delete this.customPaths[command];
    for (const t of this.tools.filter((x) => x.command === command)) {
      this.replace(path ? { ...t, status: "custom", path, version: null } : { ...t, status: "missing", path: null });
    }
  }

  async chooseExecutable() {
    return this.chosen;
  }
}

let backend: ToolsBackend | null = null;

export function toolsBackend(): ToolsBackend {
  backend ??= isTauri() ? tauriToolsBackend : new MemoryToolsBackend();
  return backend;
}

/** Test hook. */
export function setToolsBackend(b: ToolsBackend | null) {
  backend = b;
}
