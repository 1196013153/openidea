import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { runServiceItems, sessionStatus } from "./services";
import type { RunSession } from "./store";

const config = (id: string, kind: string): RunConfig => ({
  id,
  name: id,
  kind,
  command: kind,
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
});

const session = (
  id: string,
  c: RunConfig,
  status: RunSession["status"],
  startedAt: number,
  extra: Partial<RunSession> = {},
): RunSession => ({
  id,
  config: c,
  runId: null,
  status,
  exitCode: null,
  startedAt,
  endedAt: null,
  stdinClosed: false,
  ...extra,
});

describe("run configurations in Services", () => {
  const build = config("build", "cargo");
  const test = config("test", "cargo");
  const dev = config("dev", "npm");
  const scratch = config("context:file", "python");

  it("lists added types fully and other types only with their runs", () => {
    const sessions = [
      session("s1", dev, "finished", 1),
      session("s2", dev, "running", 2),
      session("s3", scratch, "failed", 3, { exitCode: 2 }),
    ];
    const items = runServiceItems([build, test, dev], sessions, ["cargo"]);
    expect(items.map((i) => [i.key, i.label, i.detail])).toEqual([
      ["run:type:cargo", "Cargo", undefined],
      ["run:type:npm", "npm", "1 running"],
      ["run:type:python", "Python", undefined],
    ]);
    expect(items[0]!.children!.map((c) => [c.key, c.detail, c.dim])).toEqual([
      ["run:config:build", undefined, true],
      ["run:config:test", undefined, true],
    ]);
    // The newest session of a configuration decides its state.
    expect(items[1]!.children!.map((c) => [c.label, c.detail, c.dim, c.icon])).toEqual([
      ["dev", "Running", false, "run"],
    ]);
    expect(items[2]!.children!.map((c) => [c.key, c.detail])).toEqual([["run:config:context:file", "Failed (exit 2)"]]);
  });

  it("has no groups without added types or sessions", () => {
    expect(runServiceItems([build], [], [])).toEqual([]);
  });

  it("describes session states", () => {
    expect(sessionStatus(undefined)).toBeUndefined();
    expect(sessionStatus(session("a", build, "starting", 0))).toBe("Starting");
    expect(sessionStatus(session("a", build, "failed", 0, { stopped: true }))).toBe("Stopped");
    expect(sessionStatus(session("a", build, "finished", 0))).toBe("Finished");
  });
});
