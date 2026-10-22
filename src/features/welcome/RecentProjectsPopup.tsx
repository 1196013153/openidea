import { useEffect } from "react";
import { create } from "zustand";
import { useProject } from "@/platform/project";
import { Dialog } from "@/ui";
import { RecentList } from "./RecentList";
import { loadRecent } from "./recent";
import styles from "./Welcome.module.css";

export const useRecentPopup = create<{ open: boolean }>(() => ({ open: false }));

export function showRecentProjectsPopup() {
  useRecentPopup.setState({ open: true });
}

const close = () => useRecentPopup.setState({ open: false });

/** File › Open Recent: chooser over recent projects (overlay contribution). */
export function RecentProjectsPopup() {
  const open = useRecentPopup((s) => s.open);
  const current = useProject((s) => s.project?.root ?? null);
  useEffect(() => {
    if (open) void loadRecent();
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={close}
      position="top"
      width={560}
      transparentBackdrop
      aria-label="Recent Projects"
      className={styles.popup}
    >
      <div className={styles.popupHeader}>Recent Projects</div>
      <RecentList compact autoFocus exclude={current} onOpened={close} className={styles.popupList} />
    </Dialog>
  );
}
