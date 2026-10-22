/** Content of the native Settings window: title bar, page tree + page, buttons. */
import { useEffect, useRef } from "react";
import { OverlayHost } from "@/workbench/OverlayHost";
import { usePlatform } from "@/platform/platformInfo";
import { TitleBar } from "@/workbench/TitleBar";
import { useApplyTheme } from "@/workbench/theme";
import { SettingsFooter, SettingsLayout } from "../dialog/SettingsDialog";
import { useSettingsDialog } from "../model/staging";
import styles from "../dialog/SettingsDialog.module.css";

export function SettingsWindow() {
  useApplyTheme();
  const ownTitleBar = usePlatform((s) => s.overlayTitleBar || s.framelessTitleBar);
  const open = useSettingsDialog((s) => s.open);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div ref={ref} className={styles.window}>
      {/* macOS overlays traffic lights on it; Windows is frameless. Linux keeps the OS title bar. */}
      {ownTitleBar && <TitleBar minimal dialog title="Settings" />}
      {open && (
        <>
          <div className={styles.windowBody}>
            <SettingsLayout />
          </div>
          <div className={styles.windowFooter}>
            <SettingsFooter />
          </div>
        </>
      )}
      <OverlayHost />
    </div>
  );
}
