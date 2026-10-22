import { describe, expect, it, vi } from "vitest";

const show = vi.fn();
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  toolWindowService: () => ({ show }),
}));
vi.mock("./ipc", async (orig) => ({
  ...(await orig<typeof import("./ipc")>()),
  readManyFileLines: async () => new Map([["/p/b.rs", ["", "    used();"]]]),
}));

const { showUsageResults, useUsages } = await import("./usages");

describe("showUsageResults", () => {
  it("shows given usages in the Find Usages tool window", async () => {
    const loc = { path: "/p/b.rs", range: { start: { line: 1, col: 4 }, end: { line: 1, col: 8 } } };
    await showUsageResults({ symbol: "used", locations: [loc] });
    expect(show).toHaveBeenCalledWith("usages");
    const search = useUsages.getState().search!;
    expect(search).toMatchObject({ symbol: "used", loading: false, error: null, rerun: null });
    expect(search.groups).toEqual([{ path: "/p/b.rs", usages: [{ path: "/p/b.rs", line: 1, col: 4, endCol: 8, text: "    used();" }] }]);
  });

  it("ignores malformed arguments", async () => {
    show.mockClear();
    await showUsageResults({ symbol: "x" });
    expect(show).not.toHaveBeenCalled();
  });
});
