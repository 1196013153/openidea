/**
 * macOS native window tabs: when project windows are merged into tabs, the native
 * title bar row (traffic lights) and tab bar are drawn over the top of the page. The
 * shell reports their height (`openidea://native-tab-bar`); the title bar starts below.
 */
import { useEffect, useState } from "react";
import { commands, isTauri } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";

export const NATIVE_TAB_BAR_EVENT = "openidea://native-tab-bar";

/** Height in px of the native chrome over this window while tabbed, 0 without tabs. */
export function useNativeTabBarHeight(enabled: boolean): number {
  const overlay = usePlatform((s) => s.overlayTitleBar);
  const [height, setHeight] = useState(0);
  const active = enabled && overlay && isTauri();
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const set = (h: unknown) => !disposed && setHeight(typeof h === "number" && h > 0 ? h : 0);
    void commands.windowNativeTabBar().then(set, () => undefined);
    void import("@tauri-apps/api/webviewWindow").then(async ({ getCurrentWebviewWindow }) => {
      const off = await getCurrentWebviewWindow().listen<number>(NATIVE_TAB_BAR_EVENT, (e) => set(e.payload));
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active]);
  return active ? height : 0;
}
