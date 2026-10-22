import { registerAction, registerActions } from "@/platform/actions";
import { useContributions } from "../contributions";
import { focusEditor } from "../focus";
import {
  activateToolWindow,
  hideActiveToolWindow,
  hideAllToolWindows,
  jumpToLastToolWindow,
  useToolWindowLayout,
  toggleMaximizeToolWindow,
} from "./store";

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
      id: "toolwindow.hideActive",
      title: "Hide Active Tool Window",
      category: "Window",
      when: "toolWindowFocus && !popupOpen",
      run: hideActiveToolWindow,
    },
    {
      id: "toolwindow.focusEditor",
      title: "Focus Editor",
      category: "Window",
      when: "toolWindowFocus && !popupOpen",
      run: () => focusEditor(),
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
