import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      debugScopes: () => ok([{ name: "Locals", variablesReference: 1, expensive: false }]),
      debugVariables: () =>
        ok([
          { name: "count", value: "3", typeName: "int", variablesReference: 0, evaluateName: "count" },
          { name: "label", value: "'hi'", typeName: "str", variablesReference: 0, evaluateName: "label" },
        ]),
    },
  };
});

import { useDebug, type DebugSession } from "../state";
import { DebugTabs, DebugToolWindow } from "../ui/DebugToolWindow";

const session: DebugSession = {
  id: 1,
  name: "main",
  adapter: "debugpy",
  parent: null,
  launch: null,
  process: null,
  status: "paused",
  stoppedThread: 1,
  stopReason: "breakpoint",
  stopDescription: null,
  threads: [{ id: 1, name: "MainThread" }],
  selectedThread: 1,
  frames: [{ id: 7, name: "main", path: "/p/app/main.py", line: 11, column: 0, presentationHint: null }],
  selectedFrame: 7,
  hits: 1,
  exitCode: null,
  caps: null,
};

describe("debug tool window", () => {
  it("renders session tabs, views, frames and typed variables", async () => {
    useDebug.setState({ sessions: { 1: session }, active: 1 });
    render(
      <>
        <DebugTabs />
        <DebugToolWindow />
      </>,
    );
    expect(screen.getByRole("tab", { name: /main/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Threads & Variables" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Console" })).toBeTruthy();
    expect(screen.getByText(", main.py:12")).toBeTruthy();
    expect(screen.getByPlaceholderText("Evaluate expression (↩) or add a watch (⇧⌘↩)")).toBeTruthy();
    expect(await screen.findByText("{int}")).toBeTruthy();
    expect(screen.getByText("'hi'")).toBeTruthy();
  });
});
