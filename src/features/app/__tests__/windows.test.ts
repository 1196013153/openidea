import { beforeEach, describe, expect, it, vi } from "vitest";

const windowOpenProject = vi.fn();
const windowTakeLaunch = vi.fn();
const openProject = vi.fn(async (path: string) => ({ root: path, name: path, isGit: false, settings: {} }));

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      windowOpenProject: (...a: unknown[]) => windowOpenProject(...a),
      windowTakeLaunch: () => windowTakeLaunch(),
    },
  };
});
vi.mock("@/platform/project", async (orig) => {
  const real = await orig<typeof import("@/platform/project")>();
  return { ...real, openProject: (p: string) => openProject(p) };
});

const { openProjectInWindow, consumeLaunch } = await import("../windows");
const { useProject } = await import("@/platform/project");

beforeEach(() => {
  windowOpenProject.mockReset();
  windowTakeLaunch.mockReset();
  openProject.mockClear();
  useProject.setState({ project: null });
});

describe("openProjectInWindow", () => {
  it("opens in this window when the backend says `current`", async () => {
    windowOpenProject.mockResolvedValue({ status: "ok", data: { kind: "current" } });
    await openProjectInWindow("/p/a", false);
    expect(windowOpenProject).toHaveBeenCalledWith("/p/a", false);
    expect(openProject).toHaveBeenCalledWith("/p/a");
  });

  it("asks for a new window when this one already has a project", async () => {
    useProject.setState({ project: { root: "/p/b", name: "b", isGit: false, settings: {} } });
    windowOpenProject.mockResolvedValue({ status: "ok", data: { kind: "opened", label: "project-1" } });
    await openProjectInWindow("/p/a", false);
    expect(windowOpenProject).toHaveBeenCalledWith("/p/a", true);
    expect(openProject).not.toHaveBeenCalled();
  });

  it("does nothing locally when another window was focused", async () => {
    windowOpenProject.mockResolvedValue({ status: "ok", data: { kind: "focused", label: "main" } });
    await openProjectInWindow("/p/a", true);
    expect(openProject).not.toHaveBeenCalled();
  });
});

describe("launch", () => {
  it("opens the pending project once", async () => {
    windowTakeLaunch.mockResolvedValueOnce({ project: "/p/launch" }).mockResolvedValueOnce(null);
    await consumeLaunch();
    await consumeLaunch();
    expect(openProject).toHaveBeenCalledTimes(1);
    expect(openProject).toHaveBeenCalledWith("/p/launch");
  });
});
