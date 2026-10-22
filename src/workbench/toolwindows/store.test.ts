import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContext } from "@/platform/context";
import { executeAction, getAction } from "@/platform/actions";
import { registerToolWindow } from "../contributions";
import { installToolWindowActions } from "./actions";
import {
  activateToolWindow,
  hideActiveToolWindow,
  hideAllToolWindows,
  hideToolWindow,
  hasStripeButton,
  removeFromStripe,
  anchorOf,
  isToolWindowVisible,
  loadToolWindowLayout,
  moveToolWindow,
  resetToolWindowPlacements,
  sanitizePlacements,
  resetToolWindowLayout,
  setFocusedToolWindow,
  setToolWindowSize,
  showToolWindow,
  toggleToolWindow,
  toolWindowServiceImpl,
  useToolWindowLayout,
} from "./store";

const Empty = () => null;
let disposers: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  resetToolWindowLayout();
  disposers = [
    registerToolWindow({ id: "project", title: "Project", icon: "folder", anchor: "left", component: Empty }),
    registerToolWindow({ id: "structure", title: "Structure", icon: "structure", anchor: "left", component: Empty }),
    registerToolWindow({ id: "terminal", title: "Terminal", icon: "terminal", anchor: "bottom", component: Empty }),
    registerToolWindow({ id: "problems", title: "Problems", icon: "problems", anchor: "bottom", component: Empty }),
  ];
  loadToolWindowLayout("/work/a");
});

afterEach(() => disposers.forEach((d) => d()));

describe("tool window semantics", () => {
  it("shows one window per anchor; showing another replaces it", () => {
    expect(isToolWindowVisible("project")).toBe(true);
    showToolWindow("structure");
    expect(isToolWindowVisible("structure")).toBe(true);
    expect(isToolWindowVisible("project")).toBe(false);
    showToolWindow("terminal");
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(isToolWindowVisible("structure")).toBe(true);
    expect(getContext()["toolWindow.terminal.visible"]).toBe(true);
    // previously shown windows stay mounted (keep-alive)
    expect(useToolWindowLayout.getState().mounted.has("project")).toBe(true);
  });

  it("toggle shows (requesting focus) and hides", () => {
    toggleToolWindow("terminal");
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(useToolWindowLayout.getState().focusRequest?.id).toBe("terminal");
    toggleToolWindow("terminal");
    expect(isToolWindowVisible("terminal")).toBe(false);
  });

  it("activate: hidden → show, visible unfocused → focus, focused → hide", () => {
    activateToolWindow("problems");
    expect(isToolWindowVisible("problems")).toBe(true);
    const seq = useToolWindowLayout.getState().focusRequest!.seq;
    activateToolWindow("problems");
    expect(isToolWindowVisible("problems")).toBe(true);
    expect(useToolWindowLayout.getState().focusRequest!.seq).toBeGreaterThan(seq);
    setFocusedToolWindow("problems");
    expect(getContext().toolWindowFocus).toBe(true);
    expect(getContext().activeToolWindow).toBe("problems");
    activateToolWindow("problems");
    expect(isToolWindowVisible("problems")).toBe(false);
  });

  it("hide all stashes and restores; hide active hides the focused window", () => {
    showToolWindow("terminal");
    hideAllToolWindows();
    expect(isToolWindowVisible("project")).toBe(false);
    expect(isToolWindowVisible("terminal")).toBe(false);
    hideAllToolWindows();
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
    setFocusedToolWindow("terminal");
    hideActiveToolWindow();
    expect(isToolWindowVisible("terminal")).toBe(false);
    expect(isToolWindowVisible("project")).toBe(true);
  });

  it("ignores unknown ids and hiding a window that isn't visible", () => {
    showToolWindow("nope");
    hideToolWindow("structure");
    expect(isToolWindowVisible("project")).toBe(true);
  });

  it("is exposed through the ToolWindowService", () => {
    toolWindowServiceImpl.show("terminal");
    expect(toolWindowServiceImpl.isVisible("terminal")).toBe(true);
    toolWindowServiceImpl.hide("terminal");
    expect(toolWindowServiceImpl.isVisible("terminal")).toBe(false);
  });
});

describe("tool window persistence", () => {
  it("persists visible windows and sizes per project root", () => {
    showToolWindow("structure");
    showToolWindow("terminal");
    setToolWindowSize("bottom", 333);
    loadToolWindowLayout("/work/b");
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(false);
    expect(useToolWindowLayout.getState().sizes.bottom).not.toBe(333);
    loadToolWindowLayout("/work/a");
    expect(isToolWindowVisible("structure")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(useToolWindowLayout.getState().sizes.bottom).toBe(333);
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("openidea.layout.v1:/work/c", "{not json");
    loadToolWindowLayout("/work/c");
    expect(isToolWindowVisible("project")).toBe(true);
  });
});

describe("tool window actions", () => {
  it("registers toolwindow.<id> and generic actions", async () => {
    const dispose = installToolWindowActions();
    expect(getAction("toolwindow.terminal")?.title).toBe("Terminal");
    expect(getAction("toolwindow.hideAll")).toBeDefined();
    await executeAction("toolwindow.terminal");
    expect(isToolWindowVisible("terminal")).toBe(true);
    const late = registerToolWindow({ id: "git", title: "Git", icon: "branch", anchor: "bottom", component: Empty });
    expect(getAction("toolwindow.git")).toBeDefined();
    late();
    expect(getAction("toolwindow.git")).toBeUndefined();
    dispose();
    expect(getAction("toolwindow.terminal")).toBeUndefined();
  });

  it("a later registration with the same id replaces the earlier one", () => {
    const Real = () => null;
    const disposeReal = registerToolWindow({
      id: "project",
      title: "Project",
      icon: "folder",
      anchor: "left",
      component: Real,
    });
    disposers[0]!(); // the earlier (sample) disposer must not remove the replacement
    expect(isToolWindowVisible("project")).toBe(true);
    disposeReal();
  });
});

describe("tool window placement", () => {
  it("moves a window to another stripe group, keeps it visible and persists", () => {
    showToolWindow("structure");
    moveToolWindow("structure", "right-top");
    expect(anchorOf("structure")).toBe("right");
    expect(useToolWindowLayout.getState().visible).toMatchObject({ left: null, right: "structure" });
    expect(getContext()["toolWindow.structure.visible"]).toBe(true);
    loadToolWindowLayout("/work/a");
    expect(anchorOf("structure")).toBe("right");
    expect(useToolWindowLayout.getState().visible.right).toBe("structure");
    loadToolWindowLayout("/work/b");
    expect(anchorOf("structure")).toBe("left");
  });

  it("orders windows within the target group", () => {
    moveToolWindow("terminal", "left-top", "project");
    const p = useToolWindowLayout.getState().placements;
    expect(p.terminal).toMatchObject({ anchor: "left" });
    expect(p.terminal!.order!).toBeLessThan(p.project!.order!);
    moveToolWindow("terminal", "left-bottom");
    expect(anchorOf("terminal")).toBe("bottom");
  });

  it("restores the default layout", () => {
    moveToolWindow("project", "right-bottom");
    expect(useToolWindowLayout.getState().placements.project).toMatchObject({ anchor: "right", secondary: true });
    resetToolWindowPlacements();
    expect(anchorOf("project")).toBe("left");
  });

  it("sanitizes stored placements", () => {
    expect(sanitizePlacements({ a: { anchor: "top" }, b: { anchor: "bottom", order: 5, secondary: 1 }, c: null })).toEqual({
      b: { anchor: "bottom", order: 5, secondary: true },
    });
  });
});

describe("stripe buttons", () => {
  const find = { id: "find", title: "Find", icon: "search", anchor: "bottom" as const, component: Empty, stripe: "onUse" as const };
  const buttons = () => useToolWindowLayout.getState().stripeButtons;

  it("adds an on-use window's button when opened and removes it on Hide, persisted per project", () => {
    disposers.push(registerToolWindow(find));
    expect(hasStripeButton(find, buttons())).toBe(false);
    showToolWindow("find");
    expect(hasStripeButton(find, buttons())).toBe(true);
    removeFromStripe("find");
    expect(isToolWindowVisible("find")).toBe(false);
    expect(hasStripeButton(find, buttons())).toBe(false);

    removeFromStripe("terminal");
    loadToolWindowLayout("/work/a");
    expect(buttons()).toEqual({ find: false, terminal: false });
    resetToolWindowPlacements();
    expect(buttons()).toEqual({});
  });
});
