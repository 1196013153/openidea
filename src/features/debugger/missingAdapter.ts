/**
 * A debug adapter that is not installed: name it and offer the one-click install
 * (ide-tools) followed by the same launch again, instead of a bare error.
 */
import { IpcError } from "@/platform/ipc";

/** Adapters the tools installer can provide (adapter id → tool name). */
const INSTALLABLE: Record<string, { tool: string; label: string }> = {
  debugpy: { tool: "debugpy", label: "debugpy" },
  "js-debug": { tool: "js-debug", label: "the JavaScript debugger (vscode-js-debug)" },
  delve: { tool: "delve", label: "Delve" },
  codelldb: { tool: "codelldb", label: "CodeLLDB" },
};

export interface MissingAdapter {
  tool: string;
  title: string;
  body: string;
}

/** The install offer for a failed start, or null when the failure is something else. */
export function missingAdapter(adapter: string, e: unknown): MissingAdapter | null {
  const entry = INSTALLABLE[adapter];
  if (!entry || !(e instanceof IpcError) || e.kind !== "unavailable") return null;
  if (adapter === "debugpy" && e.message.startsWith("debugpy is not installed")) {
    return {
      tool: entry.tool,
      title: "debugpy is not installed",
      body: `${e.message}. OpenIDEA can install a private copy that every Python interpreter uses for debugging.`,
    };
  }
  if (!e.message.startsWith(`debug adapter \`${adapter}\` not found`)) return null;
  return {
    tool: entry.tool,
    title: `${entry.label[0]!.toUpperCase()}${entry.label.slice(1)} is not installed`,
    body: e.message,
  };
}
