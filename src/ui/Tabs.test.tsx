import { describe, expect, it } from "vitest";
import { dropIndex, revealHorizontally } from "./Tabs";

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
