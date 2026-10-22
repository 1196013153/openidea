/**
 * Settings: the Settings window (⌘,, action `file.settings`) with built-in
 * pages (Appearance, System Settings, Keymap, Editor › General / Font / Code
 * Style / Files) plus pages contributed via `registerSettingsPage`, and the
 * runtime application of keymap / UI font size / high-contrast settings.
 *
 * On the desktop Settings open in a native child window (`activateSettingsWindow`
 * runs there); in the browser build they open as an in-page dialog.
 *
 * `executeAction("file.settings", "keymap")` opens a specific page.
 */
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { registerActions, type Action } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { isPopupOpen, lazyComponent } from "@/ui";
import { loadSettings, useProject } from "@/platform/project";
import { registerOverlay } from "@/workbench/contributions";
import { LazySettingsDialog, loadBuiltinPages, unloadBuiltinPages } from "./dialog/LazySettingsDialog";
import { closeSettings, openSettings, selectPage, setQuery, useSettingsDialog } from "./model/staging";
import { zoomActions } from "./appearanceRuntime";
import { trackRuntimeSettings } from "./runtime";
import { installActionProxies, installSettingsHost } from "./window/bridge";

export { settingsWindowParent } from "./window/bridge";
export const SettingsWindow = lazyComponent(() => import("./window/SettingsWindow").then((m) => m.SettingsWindow));

/** Same event as `windows::LAUNCH_EVENT`: a pending launch (page) is waiting. */
const LAUNCH_EVENT = "openidea://launch";

function settingsActions(open: (page?: string) => void): Action[] {
  return [
    {
      id: "file.settings",
      title: "Settings…",
      category: "File",
      icon: "settings",
      keywords: ["preferences", "options", "configure"],
      run: ({ arg }) => open(typeof arg === "string" ? arg : undefined),
    },
    {
      id: "settings.keymap",
      title: "Keymap…",
      category: "File",
      icon: "keyboard",
      keywords: ["shortcuts", "keyboard", "bindings"],
      run: () => open("keymap"),
    },
    {
      id: "settings.appearance",
      title: "Appearance…",
      category: "View",
      icon: "sun",
      keywords: ["theme", "accent", "font size"],
      run: () => open("appearance"),
    },
  ];
}

/** Native Settings window when the backend can make one, else the dialog. */
async function showSettings(page?: string) {
  if (isTauri()) {
    try {
      const frame = getComputedStyle(document.documentElement).getPropertyValue("--bg-frame").trim();
      await call(commands.windowOpenSettings(page ?? null, frame || null));
      return;
    } catch (e) {
      console.warn("settings window unavailable, using the dialog", e);
    }
  }
  await loadBuiltinPages();
  openSettings(page);
}

export function activate(): () => void {
  const disposers = [
    trackRuntimeSettings(),
    unloadBuiltinPages,
    registerOverlay({ id: "settings.dialog", component: LazySettingsDialog }),
    registerActions(zoomActions()),
    registerActions(settingsActions((page) => void showSettings(page))),
    isTauri() ? installSettingsHost() : () => {},
  ];
  return () => disposers.reverse().forEach((d) => d());
}

function navigate(page: string | undefined) {
  if (!page) return;
  setQuery("");
  selectPage(page);
}

async function takeLaunchPage(): Promise<string | undefined> {
  const launch = await commands.windowTakeLaunch().catch(() => null);
  return launch?.settingsPage ?? undefined;
}

function listenLaunch(): () => void {
  let disposed = false;
  let off: (() => void) | undefined;
  void getCurrentWebviewWindow()
    .listen(LAUNCH_EVENT, () => void takeLaunchPage().then(navigate))
    .then((u) => {
      if (disposed) return u();
      off = u;
      // A page requested before we listened: its event is gone, the launch is not.
      void takeLaunchPage().then(navigate);
    });
  return () => {
    disposed = true;
    off?.();
  };
}

/** Esc and ⌘W cancel, like closing the window; ⌘, stays here. */
function installWindowKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if ((e.key === "Escape" && !isPopupOpen()) || (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "w")) {
      e.preventDefault();
      closeSettings();
    } else if (mod && e.key === ",") {
      e.preventDefault();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/**
 * The settings window (`settings-<parent>`): settings pages only, working on
 * the parent's project; Cancel / OK / Esc close the window.
 */
export function activateSettingsWindow(parent: string): () => void {
  const disposers = [
    trackRuntimeSettings(),
    unloadBuiltinPages,
    registerActions(settingsActions(navigate)),
    installActionProxies(parent),
    listenLaunch(),
    installWindowKeys(),
    useSettingsDialog.subscribe((s, prev) => {
      if (prev.open && !s.open) void getCurrentWebviewWindow().close();
    }),
  ];
  void (async () => {
    await loadBuiltinPages();
    const project = await commands.projectCurrent().catch(() => null);
    if (project) useProject.setState({ project, settings: project.settings });
    else await loadSettings().catch((e) => console.warn("cannot load settings", e));
    openSettings(await takeLaunchPage());
  })();
  return () => disposers.reverse().forEach((d) => d());
}
