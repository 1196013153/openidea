import { registerAction, registerActions } from "@/platform/actions";
import { formatMessage, tx } from "@/platform/i18n";
import { occurrenceNavigator, showStatusInfo, useContributions } from "../contributions";
import { focusEditor } from "../focus";
import { closeSelectedContent } from "./content";
import {
  activateToolWindow,
  hideActiveToolWindow,
  hideAllToolWindows,
  hideToolWindow,
  jumpToLastToolWindow,
  lastUsedToolWindow,
  useToolWindowLayout,
  toggleMaximizeToolWindow,
} from "./store";

/**
 * Next / Previous Occurrence: steps through the results of the focused tool
 * window, else of the last active one, else of a shown one, so it also works
 * from the editor. The editor gets the focus only when the action ran outside
 * the tool window.
 */
export function goToOccurrence(dir: 1 | -1): boolean {
  const s = useToolWindowLayout.getState();
  for (const id of new Set([s.focused, s.lastActive, lastUsedToolWindow(), ...Object.values(s.visible)])) {
    const nav = id ? occurrenceNavigator(id) : null;
    if (!nav) continue;
    const step = nav.go(dir, s.focused !== id);
    if (step) showStatusInfo(formatMessage(tx("{index} of {total}"), { index: step.index, total: step.total }));
    return !!step;
  }
  return false;
}

/** Registers `toolwindow.<id>` for every tool window plus the generic tool window actions. */
export function installToolWindowActions(): () => void {
  const perWindow = new Map<string, { title: string; icon: string; dispose: () => void }>();

  const sync = () => {
    const windows = useContributions.getState().toolWindows;
    for (const [id, entry] of perWindow) {
      const tw = windows.get(id);
      if (!tw || tw.title !== entry.title || tw.icon !== entry.icon) {
        entry.dispose();
        perWindow.delete(id);
      }
    }
    for (const [id, tw] of windows) {
      if (perWindow.has(id)) continue;
      const dispose = registerAction({
        id: `toolwindow.${id}`,
        title: tw.title,
        category: "Tool Windows",
        icon: tw.icon,
        keywords: ["tool window", "show", "hide"],
        run: () => activateToolWindow(id),
      });
      perWindow.set(id, { title: tw.title, icon: tw.icon, dispose });
    }
  };
  sync();
  const unsubscribe = useContributions.subscribe((s, prev) => {
    if (s.toolWindows !== prev.toolWindows) sync();
  });

  const disposeStatic = registerActions([
    { id: "toolwindow.hideAll", title: "Hide All Tool Windows", category: "Window", run: hideAllToolWindows },
    {
      id: "toolwindow.jumpToLast",
      title: "Jump to Last Tool Window",
      category: "Window",
      keywords: ["tool window", "focus"],
      when: "projectOpen",
      run: jumpToLastToolWindow,
    },
    {
      // IDEA: also from the editor, hiding the last active window if it is still shown.
      id: "toolwindow.hideActive",
      title: "Hide Active Tool Window",
      category: "Window",
      when: "projectOpen && !popupOpen",
      run: hideActiveToolWindow,
    },
    {
      // Close Content, as IDEA (⌘W / Ctrl+F4 in a tool window): the selected closable tab, else the window.
      id: "toolwindow.closeContent",
      title: "Close Tool Window Tab",
      category: "Window",
      when: "toolWindowFocus && !popupOpen",
      run: () => {
        const s = useToolWindowLayout.getState();
        const id = s.focused ?? s.lastActive;
        if (id && !closeSelectedContent(id)) hideToolWindow(id);
      },
    },
    {
      id: "toolwindow.focusEditor",
      title: "Focus Editor",
      category: "Window",
      when: "toolWindowFocus && !popupOpen",
      run: () => focusEditor(),
    },
    {
      id: "navigate.nextOccurrence",
      title: "Next Occurrence",
      category: "Navigate",
      icon: "arrow-down",
      keywords: ["usage", "result", "find"],
      when: "projectOpen",
      run: () => void goToOccurrence(1),
    },
    {
      id: "navigate.prevOccurrence",
      title: "Previous Occurrence",
      category: "Navigate",
      icon: "arrow-up",
      keywords: ["usage", "result", "find"],
      when: "projectOpen",
      run: () => void goToOccurrence(-1),
    },
    {
      id: "toolwindow.maximize",
      title: "Maximize Tool Window",
      category: "Window",
      when: "toolWindowFocus",
      run: () => {
        const s = useToolWindowLayout.getState();
        const id = s.focused ?? s.lastActive;
        if (id) toggleMaximizeToolWindow(id);
      },
    },
  ]);

  return () => {
    unsubscribe();
    disposeStatic();
    perWindow.forEach((e) => e.dispose());
    perWindow.clear();
  };
}
