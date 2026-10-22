/**
 * Native menu ↔ action system.
 *
 * The backend emits `openidea://menu` `{ action, arg }` to the focused window when
 * an IDE menu item is clicked; we run `executeAction(action, arg)`. In the
 * other direction we push localised labels (`menu.*` catalog keys) and the
 * shortcut text of every keymap binding, so the menu shows the JS keymap's
 * shortcuts without registering native accelerators (see src-tauri/src/menu.rs).
 */
import { executeAction } from "@/platform/actions";
import { keysWithPrefix, t, useI18n } from "@/platform/i18n";
import { commands, isTauri, type MenuConfig } from "@/platform/ipc";
import { bindingsFor, effectiveBindings, formatBinding, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { isDistractionFree, useDistractionFree } from "@/workbench/distractionFree";
import { hostOs, type HostOs } from "./host";

export const MENU_EVENT = "openidea://menu";

export interface MenuRoute {
  action: string;
  arg?: string | null;
}

export function isMenuRoute(v: unknown): v is MenuRoute {
  return typeof v === "object" && v !== null && typeof (v as MenuRoute).action === "string";
}

/** Runs the action a menu item stands for. Returns whether it ran. */
export function routeMenuEvent(payload: unknown, run = executeAction): Promise<boolean> {
  if (!isMenuRoute(payload) || !payload.action) return Promise.resolve(false);
  return run(payload.action, payload.arg ?? undefined);
}

/** Shortcut text for menus: macOS symbols, `Ctrl+Shift+O` style elsewhere. */
export function menuShortcut(binding: string, os: HostOs): string {
  return formatBinding(binding, os === "macos");
}

export function buildMenuConfig(os: HostOs): MenuConfig {
  const labels: Record<string, string> = {};
  // Per-window state some labels follow (View › Appearance › Enter / Exit Distraction Free Mode).
  const params = { os, distractionFree: isDistractionFree() ? "on" : "off" };
  for (const key of keysWithPrefix("menu.")) labels[key] = t(key, params);
  const shortcuts: Record<string, string> = {};
  for (const [, id] of effectiveBindings()) {
    if (id in shortcuts) continue;
    const first = bindingsFor(id)[0];
    if (first) shortcuts[id] = menuShortcut(first, os);
  }
  return { locale: useI18n.getState().locale, labels, shortcuts };
}

export function installMenuBridge(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const push = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void hostOs().then((os) => {
        if (!disposed) void commands.menuConfigure(buildMenuConfig(os));
      });
    }, 50);
  };

  void import("@tauri-apps/api/webviewWindow").then(async ({ getCurrentWebviewWindow }) => {
    // Window-scoped: a global `listen` would also receive other windows' menu events.
    const off = await getCurrentWebviewWindow().listen(MENU_EVENT, ({ payload }) => void routeMenuEvent(payload));
    if (disposed) off();
    else unlisten = off;
  });

  push();
  // The native menu bar is shared: a focused window re-pushes its own window-scoped labels.
  window.addEventListener("focus", push);
  const unsubs = [
    useI18n.subscribe((s, prev) => {
      if (s.messages !== prev.messages) push();
    }),
    useKeymap.subscribe(push),
    useDistractionFree.subscribe((s, prev) => {
      if (s.active !== prev.active) push();
    }),
    // Opening / closing a project changes the Open Recent list.
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) void commands.menuRefresh();
    }),
  ];
  return () => {
    disposed = true;
    clearTimeout(timer);
    window.removeEventListener("focus", push);
    unlisten?.();
    unsubs.forEach((u) => u());
  };
}
