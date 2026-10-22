import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { registerStatusItem, registerToolWindow, type StatusItemContribution } from "./contributions";
import { orderStatusItems, StatusBar, TaskStatus } from "./StatusBar";
import { orderTitleItems } from "./TitleBar";
import { Balloons, NOTIFICATIONS_TOOL_WINDOW, NotificationsToolWindow } from "./Notifications";
import {
  BALLOON_TIMEOUT,
  clearNotifications,
  installNotifyEvents,
  notify,
  useNotifications,
} from "./notificationStore";
import { installTaskEvents, useTasks } from "./tasks";
import { ToolWindowStripe } from "./toolwindows/ToolWindows";
import { isToolWindowVisible, loadToolWindowLayout, showToolWindow } from "./toolwindows/store";

const item = (id: string, align: "left" | "right", priority: number): StatusItemContribution => ({
  id,
  align,
  priority,
  component: () => <span>{id}</span>,
});

describe("status bar ordering", () => {
  it("puts higher priorities closer to the window edges", () => {
    const { left, right } = orderStatusItems([
      item("a", "left", 1),
      item("b", "left", 5),
      item("c", "right", 5),
      item("d", "right", 1),
      item("e", "right", 3),
    ]);
    expect(left.map((i) => i.id)).toEqual(["b", "a"]);
    expect(right.map((i) => i.id)).toEqual(["d", "e", "c"]);
  });

  it("renders registered items in order", () => {
    const disposers = [
      registerStatusItem(item("caret", "right", 20)),
      registerStatusItem(item("memory", "right", 60)),
      registerStatusItem(item("crumbs", "left", 0)),
      registerStatusItem(item("encoding", "right", 40)),
    ];
    render(<StatusBar />);
    const ids = [...document.querySelectorAll("[data-status-item]")].map((el) => el.getAttribute("data-status-item"));
    expect(ids).toEqual(["crumbs", "caret", "encoding", "memory"]);
    disposers.forEach((d) => d());
  });

  it("title items sort by priority within each side", () => {
    const C = () => null;
    const { left, right } = orderTitleItems([
      { id: "x", align: "right", priority: 10, component: C },
      { id: "y", align: "right", priority: 0, component: C },
      { id: "z", align: "left", priority: 0, component: C },
    ]);
    expect(left.map((i) => i.id)).toEqual(["z"]);
    expect(right.map((i) => i.id)).toEqual(["y", "x"]);
  });
});

describe("background tasks", () => {
  it("tracks task events and shows the current task", () => {
    vi.useFakeTimers();
    const uninstall = installTaskEvents();
    const dispose = registerStatusItem({ id: "workbench.tasks", align: "right", priority: 0, component: TaskStatus });
    render(<StatusBar />);
    act(() => {
      emitLocalIdeEvent({ type: "task", id: 6, title: "Publish Diagnostics", message: null, fraction: null, done: false });
      emitLocalIdeEvent({ type: "task", id: 7, title: "Building index", message: null, fraction: 0.5, done: false });
    });
    expect(screen.queryByText("Building index")).toBeNull();
    act(() => {
      emitLocalIdeEvent({ type: "task", id: 6, title: "Publish Diagnostics", message: null, fraction: 1, done: true });
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByText("Publish Diagnostics")).toBeNull();
    expect(screen.getByText("Building index")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")[0]).toHaveAttribute("aria-valuenow", "50");
    act(() => emitLocalIdeEvent({ type: "indexState", indexing: true, files: 10, symbols: 20 }));
    expect(useTasks.getState().tasks).toHaveLength(2);
    dispose();
    uninstall();
    useTasks.setState({ tasks: [], indexing: null });
    vi.useRealTimers();
  });
});

describe("notifications", () => {
  afterEach(() => {
    clearNotifications();
    vi.useRealTimers();
  });

  it("shows balloons; info auto-dismisses, errors stay", () => {
    vi.useFakeTimers();
    render(<Balloons />);
    act(() => {
      notify({ level: "info", title: "Saved" });
      notify({ level: "error", title: "Build failed", actions: [{ label: "Show log", run: () => {} }] });
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Build failed");
    act(() => vi.advanceTimersByTime(BALLOON_TIMEOUT.info! + 10));
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByText("Build failed")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show log"));
    expect(screen.queryByText("Build failed")).toBeNull();
    expect(useNotifications.getState().items).toHaveLength(2);
  });

  it("replaces notifications with the same key and subscribes to backend notify events", () => {
    const uninstall = installNotifyEvents();
    notify({ level: "warning", title: "LSP missing", key: "lsp" });
    notify({ level: "warning", title: "LSP still missing", key: "lsp" });
    act(() => emitLocalIdeEvent({ type: "notify", level: "info", title: "From backend", body: null }));
    expect(useNotifications.getState().items.map((n) => n.title)).toEqual(["From backend", "LSP still missing"]);
    uninstall();
  });

  it("the Notifications tool window lists history, marks it read and hides balloons", () => {
    const dispose = registerToolWindow({
      id: NOTIFICATIONS_TOOL_WINDOW,
      title: "Notifications",
      icon: "bell",
      anchor: "right",
      component: NotificationsToolWindow,
    });
    loadToolWindowLayout("/notifications");
    render(
      <>
        <Balloons />
        <NotificationsToolWindow />
      </>,
    );
    act(() => void notify({ level: "info", title: "Hello" }));
    expect(screen.getAllByText("Hello")).toHaveLength(2);
    expect(useNotifications.getState().items.every((n) => n.read)).toBe(false);
    act(() => showToolWindow(NOTIFICATIONS_TOOL_WINDOW));
    expect(screen.getAllByText("Hello")).toHaveLength(1);
    expect(useNotifications.getState().items.every((n) => n.read && !n.balloon)).toBe(true);
    dispose();
  });
});

describe("tool window stripe", () => {
  it("renders left + bottom windows on the left stripe and toggles on click", () => {
    const C = () => null;
    const disposers = [
      registerToolWindow({ id: "project", title: "Project", icon: "folder", anchor: "left", component: C }),
      registerToolWindow({ id: "terminal", title: "Terminal", icon: "terminal", anchor: "bottom", component: C }),
    ];
    loadToolWindowLayout("/stripe");
    const windows = [
      { id: "project", title: "Project", icon: "folder", anchor: "left" as const, component: C },
      { id: "terminal", title: "Terminal", icon: "terminal", anchor: "bottom" as const, component: C },
    ];
    render(<ToolWindowStripe side="left" windows={windows} visible={{ left: "project", right: null, bottom: null }} />);
    const project = screen.getByRole("button", { name: "Project" });
    expect(project).toHaveAttribute("aria-pressed", "true");
    expect(project).toHaveAttribute("aria-keyshortcuts", "⌘1");
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(isToolWindowVisible("terminal")).toBe(true);
    disposers.forEach((d) => d());
  });
});

describe("workbench shell", () => {
  it("renders the welcome view without a project and the frame with one", async () => {
    const { useProject } = await import("@/platform/project");
    const { Workbench } = await import("./Workbench");
    const C = () => <div>project view</div>;
    const dispose = registerToolWindow({
      id: "project",
      title: "Project",
      icon: "folder",
      anchor: "left",
      component: C,
    });
    useProject.setState({ project: null });
    const { unmount } = render(<Workbench />);
    expect(screen.getByRole("button", { name: /Open/ })).toBeInTheDocument();
    act(() => useProject.setState({ project: { root: "/shell", name: "shell-demo", isGit: false, settings: {} } }));
    loadToolWindowLayout("/shell");
    expect(await screen.findByText("shell-demo")).toBeInTheDocument();
    expect(screen.getByText("project view")).toBeInTheDocument();
    expect(screen.getByText("Search Everywhere", { selector: "dt, dt *" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("light");
    unmount();
    dispose();
    useProject.setState({ project: null });
  });
});
