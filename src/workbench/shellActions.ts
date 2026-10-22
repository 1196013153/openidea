import { executeAction, getAction, registerActions } from "@/platform/actions";
import { isTauri } from "@/platform/ipc";
import { closeProject, openProject, useProject } from "@/platform/project";
import { notify } from "./notificationStore";
import { NOTIFICATIONS_TOOL_WINDOW } from "./Notifications";
import { activateToolWindow } from "./toolwindows/store";
import { toggleTheme } from "./theme";

export async function openProjectDialog() {
  if (!isTauri()) {
    notify({
      level: "warning",
      title: "Opening folders requires the desktop app",
      body: "Run `pnpm tauri dev` to use the file system.",
    });
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const defaultPath = useProject.getState().settings?.general?.defaultProjectDirectory?.trim() || undefined;
  const picked = await open({ directory: true, multiple: false, title: "Open Folder", defaultPath });
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  // The app feature applies "Open project in" (new / this window / ask).
  if (getAction("file.openProjectPath")) {
    await executeAction("file.openProjectPath", path);
    return;
  }
  try {
    await openProject(path);
  } catch (e) {
    notify({ level: "error", title: "Could not open project", body: e instanceof Error ? e.message : String(e) });
  }
}

/** Generic actions owned by the shell. */
export function registerShellActions(): () => void {
  return registerActions([
    {
      id: "file.openProject",
      title: "Open…",
      category: "File",
      icon: "folder-open",
      keywords: ["folder", "project"],
      run: openProjectDialog,
    },
    {
      id: "file.closeProject",
      title: "Close Project",
      category: "File",
      when: "projectOpen",
      run: async () => {
        if (useProject.getState().project) await closeProject();
      },
    },
    {
      id: "view.toggleTheme",
      title: "Toggle Light/Dark Theme",
      category: "View",
      icon: "sun",
      keywords: ["appearance", "theme"],
      run: toggleTheme,
    },
    {
      id: "view.notifications",
      title: "Notifications",
      category: "View",
      icon: "bell",
      run: () => activateToolWindow(NOTIFICATIONS_TOOL_WINDOW),
    },
  ]);
}
