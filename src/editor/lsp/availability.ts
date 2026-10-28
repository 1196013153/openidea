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

/** A busy spell at least this long is indexing / a build, not the server answering a request. */
const LONG_BUSY_MS = 1500;

/**
 * Calls `fn` when a server becomes ready after starting or after a long busy
 * spell (indexing), when earlier answers may have been incomplete. Short busy
 * spells are ignored: jdtls reports progress for the very requests a caller
 * sends, and re-asking on each of them would never stop.
 */
export function onServerSettled(fn: () => void): () => void {
  if (!isTauri()) return () => {};
  const since = new Map<number, number>();
  return onIdeEvent("languageServer", (e) => {
    if (e.status === "starting") since.set(e.server, -Infinity);
    else if (e.status === "busy") {
      if (!since.has(e.server)) since.set(e.server, Date.now());
    } else if (e.status === "ready") {
      const t = since.get(e.server);
      since.delete(e.server);
      if (t !== undefined && Date.now() - t >= LONG_BUSY_MS) fn();
    } else since.delete(e.server);
  });
}

export function installAvailabilityEvents(): () => void {
  return onIdeEvent("languageServer", (e) => {
    if (e.status === "ready") serverBackoff.clear();
  });
}
