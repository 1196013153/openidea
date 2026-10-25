import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { RunConfig } from "@/platform/ipc";
import {
  provideNotificationService,
  provideToolWindowService,
  registerMenuGroup,
  type ToolWindowService,
} from "@/workbench/contributions";
import { ConsoleModel } from "./console";
import { ConsoleView, type ConsoleInput } from "./ConsoleView";
import { buildRows, mnemonics } from "./ConfigChooser";
import { activate } from "./index";
import { resetRuns, startRun, useRun, type RunSession } from "./store";

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./dialogs", () => ({ confirmRerun: confirm, promptValue: vi.fn(), RunDialogsOverlay: () => null }));

const config = (id: string, extra: Partial<RunConfig> = {}): RunConfig => ({
  id,
  name: id,
  kind: "shell",
  command: "x",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
  ...extra,
});

const running = (id: string, c: RunConfig, runId: number | null = null): RunSession => ({
  id,
  config: c,
  runId: runId as RunSession["runId"],
  status: "running",
  exitCode: null,
  startedAt: 0,
  endedAt: null,
  stdinClosed: false,
});

beforeEach(() => {
  resetRuns();
  confirm.mockClear();
  confirm.mockResolvedValue(true);
  provideToolWindowService({ show: vi.fn(), isVisible: () => true } as unknown as ToolWindowService);
  provideNotificationService({ notify: () => undefined });
});

describe("single-instance runs (IDEA restartRunProfile)", () => {
  it("Run on a running configuration asks, then restarts it in its tab", async () => {
    const app = config("app");
    useRun.setState({ sessions: [running("run1", app)] });
    await startRun(app);
    expect(confirm).toHaveBeenCalledWith("app", 1);
    expect(useRun.getState().sessions.map((s) => s.id)).toEqual(["run1"]);
  });

  it("does nothing when the restart is cancelled", async () => {
    confirm.mockResolvedValue(false);
    const app = config("app");
    useRun.setState({ sessions: [running("run1", app)] });
    expect(await startRun(app)).toBeNull();
    expect(useRun.getState().sessions[0]!.status).toBe("running");
  });

  it("Rerun in the running tab restarts without asking", async () => {
    const app = config("app");
    useRun.setState({ sessions: [running("run1", app)] });
    await startRun(app, "run1");
    expect(confirm).not.toHaveBeenCalled();
    expect(useRun.getState().sessions.map((s) => s.id)).toEqual(["run1"]);
  });

  it("starts another instance when parallel runs are allowed", async () => {
    const app = config("app", { allowParallel: true });
    useRun.setState({ sessions: [running("run1", app)] });
    await startRun(app);
    expect(confirm).not.toHaveBeenCalled();
    expect(useRun.getState().sessions).toHaveLength(2);
  });
});

describe("Stop", () => {
  let dispose: () => void;
  beforeEach(() => {
    dispose = activate();
  });
  afterEach(() => {
    dispose();
    setContext("toolWindowFocus", false);
    setContext("activeToolWindow", "");
  });

  it("stops the selected tab's process in the focused Run tool window", async () => {
    setContext("projectOpen", true);
    useRun.setState({
      sessions: [running("run1", config("a"), 1), running("run2", config("b"), 2)],
      activeSession: "run2",
    });
    setContext("toolWindowFocus", true);
    setContext("activeToolWindow", "run");
    await executeAction("run.stop");
    expect(useRun.getState().sessions.map((s) => !!s.stopped)).toEqual([false, true]);
  });

  it("stops the only running process, including a contributed debug session", async () => {
    setContext("projectOpen", true);
    const stopDebug = vi.fn();
    const unregister = registerMenuGroup({
      id: "test.stop",
      menus: ["stopProcess"],
      items: () => [{ label: "dbg", run: stopDebug }],
    });
    await executeAction("run.stop");
    expect(stopDebug).toHaveBeenCalledOnce();
    unregister();
  });
});

describe("configuration chooser", () => {
  it("numbers the first nine configurations", () => {
    const configs = Array.from({ length: 11 }, (_, i) => config(`c${i}`));
    const rows = buildRows(configs, "");
    const numbers = mnemonics(rows);
    expect(numbers.size).toBe(9);
    expect(numbers.get("c:c0")).toBe(1);
    expect(numbers.get("c:c8")).toBe(9);
    expect(numbers.has("c:c9")).toBe(false);
  });
});

describe("console input", () => {
  function setup(pending = "") {
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: "Name: " });
    const input: ConsoleInput = { pending, onChange: vi.fn(), onSubmit: vi.fn(), onEof: vi.fn() };
    render(
      <ConsoleView
        model={model}
        version={1}
        softWrap={false}
        follow
        onFollowChange={() => undefined}
        cwd="/p"
        input={input}
      />,
    );
    return { input, log: screen.getByRole("log") };
  }

  it("types, erases and sends a line", () => {
    const { input, log } = setup("ab");
    fireEvent.keyDown(log, { key: "c" });
    expect(input.onChange).toHaveBeenLastCalledWith("abc");
    fireEvent.keyDown(log, { key: "Backspace" });
    expect(input.onChange).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(log, { key: "Enter" });
    expect(input.onSubmit).toHaveBeenCalledWith("ab");
    expect(input.onChange).toHaveBeenLastCalledWith("");
    fireEvent.keyDown(log, { key: "c", metaKey: true });
    expect(input.onChange).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(log, { key: "d", ctrlKey: true });
    expect(input.onEof).toHaveBeenCalledOnce();
  });

  it("sends the complete lines of a paste and keeps the rest pending", () => {
    const { input, log } = setup("x");
    fireEvent.paste(log, { clipboardData: { getData: () => "1\r\n2\n3" } });
    expect(vi.mocked(input.onSubmit).mock.calls).toEqual([["x1"], ["2"]]);
    expect(input.onChange).toHaveBeenLastCalledWith("3");
  });
});
