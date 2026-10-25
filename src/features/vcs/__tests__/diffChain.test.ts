import { describe, expect, it } from "vitest";
import { chainNeighbour, withChain, type DiffData } from "../diffInput";

const diff = (path: string): DiffData => ({ path, left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } });

describe("diff chain", () => {
  const items = [diff("/r/a"), diff("/r/b"), diff("/r/c")];

  it("moves to the neighbouring file, revealing the nearest difference", () => {
    const b = withChain(items, 1);
    expect(b.path).toBe("/r/b");
    const next = chainNeighbour(b, 1)!;
    expect(next).toMatchObject({ path: "/r/c", reveal: "first" });
    expect(chainNeighbour(b, -1)).toMatchObject({ path: "/r/a", reveal: "last" });
    // The neighbour keeps the chain, so F7 can continue from it.
    expect(chainNeighbour(next, -1)).toMatchObject({ path: "/r/b" });
  });

  it("stops at the ends and without a chain", () => {
    expect(chainNeighbour(withChain(items, 2), 1)).toBeNull();
    expect(chainNeighbour(withChain(items, 0), -1)).toBeNull();
    expect(chainNeighbour(withChain([diff("/r/a")], 0), 1)).toBeNull();
    expect(chainNeighbour(diff("/r/a"), 1)).toBeNull();
  });
});
