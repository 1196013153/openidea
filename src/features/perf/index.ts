/** Memory indicator, "Clear caches" and the dev performance overlay. */
import { lazyComponent } from "@/ui";
import { registerActions } from "@/platform/actions";
import { registerOverlay, registerSettingsPage, registerStatusItem } from "@/workbench/contributions";
import { perfActions } from "./actions";
import { MEMORY_WIDGET, MemoryStatus } from "./MemoryStatus";
import { PerfOverlay } from "./PerfOverlay";

/** Settings › Memory Usage (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  // Top level after Plugins, as in IDEA.
  return registerSettingsPage({
    id: "memory",
    title: "Memory Usage",
    order: 950,
    keywords: ["memory", "ram", "clear caches", "index"],
    component: lazyComponent(() => import("./MemoryUsagePage").then((m) => m.MemoryUsagePage)),
  });
}

export function activate(): () => void {
  const disposers = [
    registerActions(perfActions()),
    // Far right and hidden by default, like IDEA's memory indicator.
    registerStatusItem({ ...MEMORY_WIDGET, align: "right", priority: 100, component: MemoryStatus }),
    registerOverlay({ id: "perf.overlay", component: PerfOverlay }),
    activateSettingsPages(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
