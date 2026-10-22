import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { registerAction } from "@/platform/actions";
import type { SeDeps } from "../everywhere/controller";

const fakeDeps = (): SeDeps => ({
  findFiles: async (q) => (q ? [{ path: "/p/src/OrderController.kt", relPath: "src/OrderController.kt", score: 1, indices: [4, 5, 6] }] : []),
  findSymbols: async () => [],
  searchText: async () => {},
  cancel: () => {},
  nextRequestId: () => 1,
  actions: () => [...(globalThis as unknown as { __actions: () => [] }).__actions()],
  isEnabled: () => true,
  recentFiles: async () => ["/p/README.md"],
  recentActions: () => [],
  root: () => "/p",
  now: () => 0,
});

vi.mock("../everywhere/deps", () => ({ ipcDeps: () => fakeDeps() }));
vi.mock("../find/windowStore", async (orig) => ({
  ...(await orig<typeof import("../find/windowStore")>()),
  ipcFindDeps: () => ({
    validate: async () => {},
    start: async (_id: number, _q: unknown, onFile: (f: unknown) => void) => {
      onFile({ path: "/p/a.kt", relPath: "a.kt", matches: [{ line: 2, text: "val order = 1", ranges: [[4, 9]], textOffset: 0 }] });
      return null;
    },
    cancel: () => {},
    nextRequestId: () => 1,
  }),
}));

const { allActions } = await import("@/platform/actions");
(globalThis as unknown as { __actions: typeof allActions }).__actions = allActions;
const { SearchEverywhereOverlay } = await import("../everywhere/SearchEverywhere");
const { showSearchEverywhere, hideSearchEverywhere, useSearchEverywhere } = await import("../everywhere/store");
const { FindInFilesOverlay } = await import("../find/FindInFiles");
const { showFindPopup, hideFindPopup } = await import("../find/store");

const tick = () => act(() => new Promise((r) => setTimeout(r, 100)));

afterEach(() => {
  act(() => {
    hideSearchEverywhere();
    hideFindPopup();
  });
});

describe("Search Everywhere dialog", () => {
  it("shows recent files for an empty query, then flat results; Enter runs an action", async () => {
    const run = vi.fn();
    const dispose = registerAction({ id: "test.order", title: "Order Pizza", category: "Test", run });
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("all"));
    await tick();
    expect(screen.getByText("Recent Files")).toBeInTheDocument();
    expect(within(document.getElementById("se-results")!).getByText("README.md")).toBeInTheDocument();

    const input = screen.getByLabelText("Search query");
    fireEvent.change(input, { target: { value: "ord" } });
    await tick();
    const results = within(document.getElementById("se-results")!);
    expect(results.queryByText("Files")).toBeNull();
    expect(screen.getByText("src/OrderController.kt")).toBeInTheDocument();

    // ↓ moves from the file row to the action row.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    expect(useSearchEverywhere.getState().open).toBe(false);
    expect(run).toHaveBeenCalled();
    dispose();
  });

  it("⇥ cycles scopes and repeating the scope action toggles non-project items", async () => {
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("all"));
    await tick();
    const input = screen.getByLabelText("Search query");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(useSearchEverywhere.getState().tab).toBe("classes");
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(useSearchEverywhere.getState().tab).toBe("text");
    act(() => showSearchEverywhere("all", { toggleOnRepeat: true }));
    expect(useSearchEverywhere.getState().includeNonProject).toBe(true);
  });
});

describe("Find in Files dialog", () => {
  it("streams results and previews the replacement", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(true, { query: "order" }));
    await act(() => new Promise((r) => setTimeout(r, 250)));
    expect(screen.getByText("1 match in 1 file")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "item" } });
    expect(screen.getByText("item")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace All" })).toBeEnabled();
  });
});
