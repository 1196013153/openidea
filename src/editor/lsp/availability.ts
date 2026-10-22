/**
 * Per-document back-off after `unavailable` errors, so background features
 * (completion while typing, lightbulb, inlay hints…) don't hammer the backend
 * for files without a language server. Cleared when any server becomes ready.
 */
import { isTauri, onIdeEvent } from "@/platform/ipc";
import type { LspRefreshKind } from "@/bindings";

const BACKOFF_MS = 15_000;
const until = new Map<number, number>();

export const serverBackoff = {
  mark(doc: number) {
    until.set(doc, Date.now() + BACKOFF_MS);
  },
  active(doc: number): boolean {
    const t = until.get(doc);
    if (t === undefined) return false;
    if (t > Date.now()) return true;
    until.delete(doc);
    return false;
  },
  clear() {
    until.clear();
  },
};

/**
 * Calls `fn` when data of `kind` fetched earlier may be stale: the server asked
 * for a refresh (`workspace/inlayHint/refresh`…, e.g. after indexing) or it
 * has just (re)started, so requests made while it was down came back empty.
 */
export function onLspRefresh(kind: LspRefreshKind, fn: () => void): () => void {
  if (!isTauri()) return () => {};
  const starting = new Set<number>();
  const offRefresh = onIdeEvent("lspRefresh", (e) => {
    if (e.kind === kind) fn();
  });
  const offStatus = onIdeEvent("languageServer", (e) => {
    if (e.status === "starting") starting.add(e.server);
    else if (e.status === "ready" && starting.delete(e.server)) fn();
  });
  return () => {
    offRefresh();
    offStatus();
  };
}

export function installAvailabilityEvents(): () => void {
  return onIdeEvent("languageServer", (e) => {
    if (e.status === "ready") serverBackoff.clear();
  });
}
