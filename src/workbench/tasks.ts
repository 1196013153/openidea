/** Background task progress (from `task` / `indexState` backend events). */
import { create } from "zustand";
import { onIdeEvent } from "@/platform/ipc";

export interface BackgroundTask {
  id: number | string;
  title: string;
  message: string | null;
  /** 0..1, or null when indeterminate. */
  fraction: number | null;
  done: boolean;
  startedAt: number;
  /** Stops the task (shown as a cancel button in the Background Tasks popup). */
  cancel?: () => void;
}

interface TaskState {
  tasks: BackgroundTask[];
  indexing: { files: number; symbols: number } | null;
}

export const useTasks = create<TaskState>(() => ({ tasks: [], indexing: null }));

const DONE_LINGER_MS = 600;
/** Backend tasks that finish sooner (a language server's per-keystroke work) never reach the status bar. */
const SHOW_DELAY_MS = 500;
export const INDEX_TASK_ID = "indexing";

export function upsertTask(t: Omit<BackgroundTask, "startedAt">) {
  useTasks.setState((s) => {
    const i = s.tasks.findIndex((x) => x.id === t.id);
    const tasks = [...s.tasks];
    if (i >= 0) tasks[i] = { ...tasks[i]!, ...t };
    else if (!t.done) tasks.push({ ...t, startedAt: Date.now() });
    else return s;
    return { tasks };
  });
  if (t.done) setTimeout(() => removeTask(t.id), DONE_LINGER_MS);
}

export function removeTask(id: BackgroundTask["id"]) {
  useTasks.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
}

export function setIndexing(indexing: boolean, files: number, symbols: number) {
  useTasks.setState({ indexing: indexing ? { files, symbols } : null });
  upsertTask({
    id: INDEX_TASK_ID,
    title: "Indexing",
    message: indexing ? `${files.toLocaleString()} files · ${symbols.toLocaleString()} symbols` : null,
    fraction: null,
    done: !indexing,
  });
}

export function installTaskEvents(): () => void {
  const pending = new Map<BackgroundTask["id"], ReturnType<typeof setTimeout>>();
  const latest = new Map<BackgroundTask["id"], Omit<BackgroundTask, "startedAt">>();
  const a = onIdeEvent("task", (e) => {
    const t = { id: e.id, title: e.title, message: e.message, fraction: e.fraction, done: e.done };
    if (useTasks.getState().tasks.some((x) => x.id === t.id)) return upsertTask(t);
    if (t.done) {
      clearTimeout(pending.get(t.id));
      pending.delete(t.id);
      latest.delete(t.id);
      return;
    }
    latest.set(t.id, t);
    if (pending.has(t.id)) return;
    pending.set(
      t.id,
      setTimeout(() => {
        pending.delete(t.id);
        const last = latest.get(t.id);
        latest.delete(t.id);
        if (last) upsertTask(last);
      }, SHOW_DELAY_MS),
    );
  });
  const b = onIdeEvent("indexState", (e) => setIndexing(e.indexing, e.files, e.symbols));
  return () => {
    pending.forEach(clearTimeout);
    a();
    b();
  };
}
