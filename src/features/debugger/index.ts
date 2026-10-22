/**
 * Debugger: breakpoints (editor gutter + per-project store synced to the
 * backend), DAP sessions driven by `IdeEvent::Debug`, the Debug tool window,
 * execution point + inline values, Evaluate / View Breakpoints dialogs.
 */
import { lazyComponent } from "@/ui";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { valueTooltip } from "./editor/valueTooltip";
import { registerEditorContribution } from "@/editor/api";
import { registerOverlay, registerToolWindow } from "@/workbench/contributions";
import { registerDebugActions } from "./actions";
import { loadBreakpoints } from "./breakpoints/store";
import { loadExceptionBreakpoints } from "./breakpoints/exceptions";
import { loadSpecialBreakpoints } from "./breakpoints/special";
import { breakpointGutter } from "./editor/breakpointGutter";
import { executionPoint } from "./editor/execution";
import { onHotCodeReplace } from "./hotswap";
import { handleDebugEvent, loadWatches, publishContext, resetSessions } from "./state";
import { DebuggerOverlays } from "./ui/Overlays";

export function activate(): () => void {
  loadWatches();
  publishContext();
  loadBreakpoints(useProject.getState().project?.root ?? null);
  loadExceptionBreakpoints(useProject.getState().project?.root ?? null);
  loadSpecialBreakpoints(useProject.getState().project?.root ?? null);
  const disposers = [
    registerDebugActions(),
    registerToolWindow({
      id: "debug",
      title: "Debug",
      icon: "toolwindow-debug",
      anchor: "bottom",
      stripe: "onUse",
      order: 20,
      component: lazyComponent(() => import("./ui/DebugToolWindow").then((m) => m.DebugToolWindow)),
      headerContent: lazyComponent(() => import("./ui/DebugToolWindow").then((m) => m.DebugTabs)),
    }),
    registerOverlay({ id: "debugger", component: DebuggerOverlays }),
    registerEditorContribution({
      id: "debugger",
      order: 60,
      extensions: (ctx) => [breakpointGutter(ctx), executionPoint(ctx), valueTooltip()],
    }),
    onIdeEvent("debug", (e) => {
      if (e.event.kind === "hotCodeReplace") onHotCodeReplace(e.session, e.event);
      else handleDebugEvent(e.session, e.event);
    }),
    useProject.subscribe((s, prev) => {
      const root = s.project?.root ?? null;
      if (root !== (prev.project?.root ?? null)) {
        resetSessions();
        loadBreakpoints(root);
        loadExceptionBreakpoints(root);
        loadSpecialBreakpoints(root);
      }
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
