/** Opens file locations printed in run output (resolving relative and bare names). */
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { editorService, notifications } from "@/workbench/contributions";
import { joinPath, type FileTarget } from "./links";

async function exists(path: string): Promise<boolean> {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash) || "/";
  const name = path.slice(slash + 1);
  try {
    const entries = await call(commands.fsReadDir(dir));
    return entries.some((e) => e.name === name && e.kind !== "dir");
  } catch {
    return false;
  }
}

async function findByName(path: string): Promise<string | null> {
  const name = path.split("/").pop() ?? path;
  try {
    const hits = await call(commands.findFiles(name, 5));
    const tail = path.replace(/^\.?\//, "");
    const best = hits.find((h) => h.relPath.endsWith(tail)) ?? hits.find((h) => h.relPath.split("/").pop() === name);
    return best?.path ?? null;
  } catch {
    return null;
  }
}

/** Absolute run directory of a config (`cwd` is relative to the project root). */
export function runDirectory(cwd: string | null | undefined): string {
  const root = useProject.getState().project?.root ?? "/";
  return cwd ? joinPath(root, cwd) : root;
}

export async function resolveTarget(target: FileTarget, cwd: string): Promise<string | null> {
  if (target.resolve === "path") {
    const candidate = joinPath(cwd, target.path);
    if (await exists(candidate)) return candidate;
    // Paths printed relative to the project root (cargo in a workspace member, etc.).
    const root = useProject.getState().project?.root;
    if (root && !target.path.startsWith("/")) {
      const fromRoot = joinPath(root, target.path);
      if (fromRoot !== candidate && (await exists(fromRoot))) return fromRoot;
    }
  }
  return findByName(target.path);
}

export async function openTarget(target: FileTarget, cwd: string, focus = true): Promise<void> {
  if (!isTauri()) return;
  const path = await resolveTarget(target, cwd);
  if (!path) {
    notifications().notify({ group: "run", level: "warning", title: "File not found", body: target.path, key: "run-link" });
    return;
  }
  const selection = target.line ? { line: target.line - 1, col: Math.max(0, (target.col ?? 1) - 1) } : undefined;
  await editorService().openFile(path, { selection, focus });
}

export async function openUrl(url: string): Promise<void> {
  try {
    if (isTauri()) {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  } catch (e) {
    notifications().notify({ group: "run", level: "error", title: "Cannot open link", body: String(e) });
  }
}
