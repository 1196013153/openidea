/** Pinned Find results ("Open in Find Window"), one tab per search. */
import { create } from "zustand";
import { call, commands, nextRequestId, type SearchQuery } from "@/platform/ipc";
import { maybeToolWindowService } from "../common/services";
import { cancelRequest, streamSearch } from "../common/textSearch";
import { FindSession, IDLE, type FindDeps, type FindState } from "./session";

export interface FindTab {
  id: number;
  title: string;
  query: SearchQuery;
  replacement: string | null;
  /** Replace keeps the case of each occurrence. */
  preserveCase?: boolean;
  state: FindState;
}

interface FindWindowState {
  tabs: FindTab[];
  active: number | null;
}

export const useFindWindow = create<FindWindowState>(() => ({ tabs: [], active: null }));

export function ipcFindDeps(): FindDeps {
  return {
    validate: (q) => call(commands.searchValidate(q)).then(() => undefined),
    start: streamSearch,
    cancel: cancelRequest,
    nextRequestId,
  };
}

const sessions = new Map<number, FindSession>();
let nextTab = 1;
const MAX_TABS = 8;

function patchTab(id: number, patch: Partial<FindTab>) {
  useFindWindow.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

export function openInFindWindow(
  query: SearchQuery,
  title: string,
  replacement: string | null = null,
  deps = ipcFindDeps(),
  preserveCase = false,
) {
  const id = nextTab++;
  const session = new FindSession(deps, (state) => patchTab(id, { state }));
  sessions.set(id, session);
  useFindWindow.setState((s) => {
    let tabs = [...s.tabs, { id, title, query, replacement, preserveCase, state: IDLE }];
    while (tabs.length > MAX_TABS) {
      const old = tabs[0]!;
      sessions.get(old.id)?.dispose();
      sessions.delete(old.id);
      tabs = tabs.slice(1);
    }
    return { tabs, active: id };
  });
  void session.search(query);
  maybeToolWindowService()?.show("find", true);
  return id;
}

export function rerunFindTab(id: number) {
  const tab = useFindWindow.getState().tabs.find((t) => t.id === id);
  if (tab) void sessions.get(id)?.search(tab.query);
}

export function stopFindTab(id: number) {
  sessions.get(id)?.cancel();
}

export function closeFindTab(id: number) {
  sessions.get(id)?.dispose();
  sessions.delete(id);
  useFindWindow.setState((s) => {
    const i = s.tabs.findIndex((t) => t.id === id);
    const tabs = s.tabs.filter((t) => t.id !== id);
    const active = s.active === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.active;
    return { tabs, active };
  });
}

export function disposeFindWindow() {
  sessions.forEach((s) => s.dispose());
  sessions.clear();
  useFindWindow.setState({ tabs: [], active: null });
}
