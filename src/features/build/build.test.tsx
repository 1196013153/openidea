import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { getAction, isActionEnabled } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";
import { bindingsFor } from "@/platform/keymap";
import { IpcError, type BuildEvent, type BuildMessage, type BuildResult } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { menuGroupItems, provideNotificationService, useContributions, type NotificationService } from "@/workbench/contributions";
import { useTasks } from "@/workbench/tasks";
import { BuildView } from "./BuildView";
import { activate } from "./index";
import { appendOutput, finishSummary, formatDuration, messageFiles, rootChildren, rootNode, MAX_CONSOLE_LINES } from "./model";
import { BUILD_TASK_ID, setBuildBackend, startBuild, stopBuild, useBuildRun, type BuildBackend } from "./store";

const err = (path: string | null, line: number, text = "cannot find symbol"): BuildMessage => ({
  severity: "error",
  text,
  path,
  range: path ? { start: { line, col: 4 }, end: { line, col: 4 } } : null,
  code: null,
});
const warn = (path: string, line: number): BuildMessage => ({ ...err(path, line, "deprecated"), severity: "warning" });

describe("build model", () => {
  it("groups messages by file, errors first, build messages last", () => {
    const messages = [warn("/p/B.java", 3), err(null, 0, "BUILD FAILURE"), err("/p/A.java", 9), warn("/p/A.java", 2)];
    const children = rootChildren(messages);
    expect(children.map((c) => (c.kind === "file" ? c.path : c.kind))).toEqual(["/p/A.java", "/p/B.java", "message"]);
    const a = children[0]!;
    expect(a.kind === "file" && a.messages.map((m) => m.range?.start.line)).toEqual([2, 9]);
    expect(rootNode("demo", "failed", messages)).toMatchObject({ errors: 2, warnings: 2 });
    expect(messageFiles(messages)).toEqual(["/p/B.java", "/p/A.java"]);
  });

  it("formats IDEA's finish summaries", () => {
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(3000)).toBe("3 s");
    expect(formatDuration(3120)).toBe("3 s 120 ms");
    expect(formatDuration(65_000)).toBe("1 m 5 s");
    expect(finishSummary({ success: true, errors: 0, warnings: 0, durationMs: 3000 })).toBe("Build completed successfully in 3 s");
    expect(finishSummary({ success: true, errors: 0, warnings: 1, durationMs: 500 })).toBe(
      "Build completed successfully with 1 warning in 500 ms",
    );
    expect(finishSummary({ success: false, errors: 2, warnings: 0, durationMs: 1 })).toBe("Build failed: 2 errors");
    expect(finishSummary({ success: false, errors: 1, warnings: 2, durationMs: 1 })).toBe("Build failed: 1 error, 2 warnings");
    expect(finishSummary({ success: false, errors: 0, warnings: 0, durationMs: 1 })).toBe("Build failed");
  });

  it("splits console output into capped lines", () => {
    expect(appendOutput([], "a\nb\r\n", "out")).toEqual([
      { text: "a", kind: "out" },
      { text: "b", kind: "out" },
    ]);
    const many = appendOutput([], "x\n".repeat(MAX_CONSOLE_LINES + 5), "out");
    expect(many).toHaveLength(MAX_CONSOLE_LINES);
  });
});

type Note = Parameters<NotificationService["notify"]>[0];

class FakeBackend implements BuildBackend {
  calls: Array<{ kind: string; file: string | null; clear: string[] }> = [];
  cancelled: number[] = [];
  private finish?: (r: BuildResult) => void;
  private fail?: (e: unknown) => void;
  emit?: (e: BuildEvent) => void;
  run(kind: string, file: string | null, _request: number, clear: string[], onEvent: (e: BuildEvent) => void) {
    this.calls.push({ kind, file, clear });
    this.emit = onEvent;
    return new Promise<BuildResult>((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
    });
  }
  cancel(request: number) {
    this.cancelled.push(request);
  }
  resolve(r: BuildResult) {
    this.finish?.(r);
  }
  reject(e: unknown) {
    this.fail?.(e);
  }
}

const result = (messages: BuildMessage[], success: boolean): BuildResult => ({
  system: "maven",
  title: "demo",
  success,
  errors: messages.filter((m) => m.severity === "error").length,
  warnings: messages.filter((m) => m.severity === "warning").length,
  durationMs: 3000,
  messages,
});

describe("build feature", () => {
  let dispose: () => void;
  let notes: Note[];
  let fake: FakeBackend;

  beforeEach(() => {
    notes = [];
    provideNotificationService({ notify: (n) => void notes.push(n) });
    fake = new FakeBackend();
    setBuildBackend(fake);
    useProject.setState({ project: { root: "/p", name: "demo" } as never });
    setContext("projectOpen", true);
    dispose = activate();
  });

  afterEach(() => {
    dispose();
    setBuildBackend(null);
    useProject.setState({ project: null });
    setContext("projectOpen", false);
  });

  it("registers the Build menu actions, shortcuts and an on-use bottom tool window", () => {
    for (const id of ["build.buildProject", "build.buildModule", "build.rebuildProject", "build.buildArtifacts"]) {
      expect(getAction(id), id).toBeDefined();
      expect(isActionEnabled(getAction(id)!)).toBe(true);
    }
    expect(bindingsFor("build.buildProject")).toContain("Meta+F9");
    expect(bindingsFor("build.buildModule")).toContain("Meta+Shift+F9");
    const tw = useContributions.getState().toolWindows.get("build");
    expect(tw).toMatchObject({ anchor: "bottom", stripe: "onUse", icon: "toolwindow-build" });
    expect(menuGroupItems("projectView", { paths: ["/p/core"] })).toContainEqual({
      kind: "action",
      action: "build.buildModule",
      arg: "/p/core",
    });
  });

  it("streams a failing build into the tree and console, then notifies and clears next time", async () => {
    const run = startBuild("build");
    await act(async () => {});
    expect(getContext()["build.running"]).toBe(true);
    expect(isActionEnabled(getAction("build.buildProject")!)).toBe(false);
    expect(useTasks.getState().tasks.some((t) => t.id === BUILD_TASK_ID && !t.done)).toBe(true);
    const messages = [err("/p/src/A.java", 11), warn("/p/src/B.java", 2)];
    await act(async () => {
      fake.emit!({ kind: "started", system: "maven", title: "demo" });
      fake.emit!({ kind: "step", command: "mvnw -B test-compile", cwd: "/p" });
      fake.emit!({ kind: "output", text: "[ERROR] /p/src/A.java:[12,5] cannot find symbol\n", stderr: false });
      fake.emit!({ kind: "message", message: messages[0]! });
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(useBuildRun.getState().lines.map((l) => l.kind)).toEqual(["system", "out"]);
    render(<BuildView />);
    expect(screen.getByText("demo")).toBeInTheDocument();
    expect(screen.getByText("A.java")).toBeInTheDocument();
    await act(async () => {
      fake.resolve(result(messages, false));
      await run;
    });
    expect(useBuildRun.getState().status).toBe("failed");
    expect(screen.getByText("deprecated")).toBeInTheDocument();
    expect(screen.getByText(":12:5")).toBeInTheDocument();
    expect(notes.at(-1)).toMatchObject({ level: "error", title: "Build failed: 1 error, 1 warning" });
    expect(getContext()["build.running"]).toBe(false);

    const second = startBuild("rebuild");
    await act(async () => {});
    expect(fake.calls.at(-1)).toEqual({ kind: "rebuild", file: null, clear: ["/p/src/A.java", "/p/src/B.java"] });
    await act(async () => {
      fake.resolve(result([], true));
      await second;
    });
    expect(notes.at(-1)).toMatchObject({ level: "info", title: "Build completed successfully in 3 s" });
  });

  it("builds the module of the given file and can be stopped", async () => {
    const run = startBuild("build", "/p/core/src/A.java");
    await act(async () => {});
    expect(fake.calls.at(-1)?.file).toBe("/p/core/src/A.java");
    stopBuild();
    expect(fake.cancelled).toHaveLength(1);
    await act(async () => {
      fake.reject(new IpcError({ kind: "cancelled", message: "cancelled" }));
      await run;
    });
    expect(useBuildRun.getState().status).toBe("cancelled");
    expect(notes).toHaveLength(0);
  });
});
