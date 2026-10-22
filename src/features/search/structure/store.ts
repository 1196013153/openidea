/**
 * Outline of the active editor, loaded on demand (while the Structure tool
 * window or the File Structure popup is mounted). Reloads when the active
 * editor changes and after 500 ms of idle following edits.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { useEditorRegistry } from "@/editor/api";
import { call, commands, type OutlineItem } from "@/platform/ipc";
import { loadJson, saveJson } from "../common/open";
import { useTracking } from "../common/tracking";

interface OutlineState {
  path: string | null;
  doc: number | null;
  items: OutlineItem[] | null;
  loading: boolean;
  error: string | null;
}

export const useOutline = create<OutlineState>(() => ({ path: null, doc: null, items: null, loading: false, error: null }));

const IDLE_MS = 500;
let consumers = 0;
let stop: (() => void) | null = null;
let seq = 0;

async function load(doc: number, path: string) {
  const my = ++seq;
  useOutline.setState((s) => (s.path === path ? { loading: true } : { path, doc, items: null, loading: true, error: null }));
  try {
    const items = await call(commands.docOutline(doc));
    if (my === seq) useOutline.setState({ path, doc, items, loading: false, error: null });
  } catch (e) {
    if (my === seq) useOutline.setState({ path, doc, loading: false, error: String((e as Error)?.message ?? e) });
  }
}

function start(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => useEditorRegistry.getState().active?.ctx ?? null;
  const reloadNow = () => {
    clearTimeout(timer);
    const ctx = current();
    if (!ctx) {
      seq++;
      useOutline.setState({ path: null, doc: null, items: null, loading: false, error: null });
      return;
    }
    void load(ctx.doc, ctx.path);
  };
  reloadNow();
  const unsubActive = useEditorRegistry.subscribe((s, prev) => {
    if (s.active?.ctx.doc !== prev.active?.ctx.doc || s.active?.ctx.path !== prev.active?.ctx.path) reloadNow();
  });
  const unsubEdits = useTracking.subscribe((s, prev) => {
    const ctx = current();
    if (!ctx || s.editVersions.get(ctx.path) === prev.editVersions.get(ctx.path)) return;
    clearTimeout(timer);
    timer = setTimeout(reloadNow, IDLE_MS);
  });
  return () => {
    clearTimeout(timer);
    unsubActive();
    unsubEdits();
  };
}

/** Keeps the outline live while the calling component is mounted. */
export function useLiveOutline() {
  useEffect(() => {
    if (consumers++ === 0) stop = start();
    return () => {
      if (--consumers === 0) {
        stop?.();
        stop = null;
      }
    };
  }, []);
}

// ---------------------------------------------------------------------------
// View options (persisted)

const OPTIONS_KEY = "openidea.structure.options.v1";

interface StructureOptions {
  alphabetical: boolean;
  autoscroll: boolean;
}

export const useStructureOptions = create<StructureOptions>(() => ({
  alphabetical: false,
  autoscroll: true,
  ...loadJson<Partial<StructureOptions>>(OPTIONS_KEY, {}),
}));

useStructureOptions.subscribe((s) => saveJson(OPTIONS_KEY, { alphabetical: s.alphabetical, autoscroll: s.autoscroll }));
