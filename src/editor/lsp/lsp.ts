/** Shared plumbing: per-editor document facet, IPC wrapper and error policy. */
import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { IpcError, call, isCancelled, isTauri } from "@/platform/ipc";
import type { IdeError } from "@/bindings";
import { showHint } from "./hint";

/** The backend document an editor shows (provided by this module's contribution). */
export const lspDoc = Facet.define<EditorDocContext, EditorDocContext | null>({
  combine: (values) => values[0] ?? null,
});

export function docOf(view: EditorView): EditorDocContext | null {
  return view.state.facet(lspDoc);
}

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: IdeError };

/**
 * Runs an LSP command. Synchronous throws (no Tauri runtime in a plain browser)
 * become `unavailable` rejections so callers have a single error path.
 */
export async function lspRequest<T>(run: () => Promise<Result<T>>): Promise<T> {
  if (!isTauri()) throw new IpcError({ kind: "unavailable", message: "No language server available" });
  try {
    return await call(run());
  } catch (e) {
    if (e instanceof IpcError) throw e;
    throw new IpcError({ kind: "internal", message: e instanceof Error ? e.message : String(e) });
  }
}

export function isUnavailable(e: unknown): boolean {
  return e instanceof IpcError && e.kind === "unavailable";
}

export const NO_SERVER = "No language server available";

/**
 * Error policy: background requests fail silently; explicit actions show a
 * small hint at the caret ("No language server available" for missing servers).
 */
export function reportLspError(view: EditorView | null, e: unknown, explicit: boolean) {
  if (isCancelled(e)) return;
  if (!explicit || !view) {
    if (!isUnavailable(e)) console.debug("[lsp]", e);
    return;
  }
  showHint(view, isUnavailable(e) ? NO_SERVER : e instanceof Error ? e.message : String(e));
}

/** Runs `fn` once `ms` after the last call; `cancel()` drops a pending run. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const run = (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  run.cancel = () => clearTimeout(t);
  return run;
}
