import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { dropIndex, revealHorizontally, TabStripRegistry, Tabs, type TabStripHandle } from "./Tabs";

describe("dropIndex", () => {
  it("finds the insertion index from tab midpoints", () => {
    const rects = [
      { left: 0, width: 100 },
      { left: 100, width: 50 },
    ];
    expect(dropIndex(10, rects)).toBe(0);
    expect(dropIndex(60, rects)).toBe(1);
    expect(dropIndex(130, rects)).toBe(2);
    expect(dropIndex(500, rects)).toBe(2);
  });
});

describe("revealHorizontally", () => {
  const el = (left: number, right: number, scrollLeft = 0) =>
    ({ scrollLeft, getBoundingClientRect: () => ({ left, right }) }) as unknown as HTMLElement;

  it("scrolls right until the whole tab (incl. close button) is visible", () => {
    const scroller = el(0, 500, 100);
    revealHorizontally(scroller, el(400, 560));
    expect(scroller.scrollLeft).toBe(160);
  });
  it("scrolls left for a tab cut off on the left", () => {
    const scroller = el(0, 500, 300);
    revealHorizontally(scroller, el(-50, 100));
    expect(scroller.scrollLeft).toBe(250);
  });
  it("aligns the left edge of a tab wider than the strip", () => {
    const scroller = el(0, 300, 0);
    revealHorizontally(scroller, el(200, 700));
    expect(scroller.scrollLeft).toBe(200);
  });
  it("leaves a fully visible tab alone", () => {
    const scroller = el(0, 500, 40);
    revealHorizontally(scroller, el(100, 200));
    expect(scroller.scrollLeft).toBe(40);
  });
});

describe("Tabs interactions", () => {
  const items = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C", closable: false },
  ];

  it("Alt+click on a close button closes the other tabs", () => {
    const onClose = vi.fn();
    const onCloseOthers = vi.fn();
    render(<Tabs items={items} activeId="a" onSelect={() => {}} onClose={onClose} onCloseOthers={onCloseOthers} />);
    const close = screen.getAllByRole("button", { name: "Close Tab" })[1]!;
    fireEvent.click(close, { altKey: true });
    expect(onCloseOthers).toHaveBeenCalledWith("b");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledWith("b");
  });

  it("lets a container close the selected tab when it is closable", () => {
    const handles: TabStripHandle[] = [];
    const register = (h: TabStripHandle) => (handles.push(h), () => void handles.splice(handles.indexOf(h), 1));
    const onClose = vi.fn();
    const ui = (activeId: string) => (
      <TabStripRegistry.Provider value={register}>
        <Tabs items={items} activeId={activeId} onSelect={() => {}} onClose={onClose} />
      </TabStripRegistry.Provider>
    );
    const { rerender, unmount } = render(ui("b"));
    expect(handles[0]!.closeSelected()).toBe(true);
    expect(onClose).toHaveBeenCalledWith("b");
    rerender(ui("c"));
    expect(handles[0]!.closeSelected()).toBe(false);
    unmount();
    expect(handles).toHaveLength(0);
  });
});
