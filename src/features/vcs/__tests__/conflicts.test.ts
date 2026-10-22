import { describe, expect, it } from "vitest";
import { blockAt, parseConflicts, resolveAll, resolutionText } from "../conflicts";

const text = [
  "keep\n",
  "<<<<<<< HEAD\n",
  "ours 1\n",
  "ours 2\n",
  "||||||| base\n",
  "base\n",
  "=======\n",
  "theirs\n",
  ">>>>>>> feature\n",
  "tail\n",
  "<<<<<<< HEAD\n",
  "=======\n",
  "only theirs\n",
  ">>>>>>> feature\n",
].join("");

describe("parseConflicts", () => {
  it("parses diff3 and plain blocks", () => {
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(2);
    const [a, b] = blocks;
    expect(a).toMatchObject({ ours: "ours 1\nours 2\n", base: "base\n", theirs: "theirs\n", oursLabel: "HEAD", theirsLabel: "feature" });
    expect(text.slice(a!.from, a!.to)).toMatch(/^<<<<<<< HEAD\n[\s\S]*>>>>>>> feature\n$/);
    expect(b).toMatchObject({ ours: "", base: null, theirs: "only theirs\n" });
    expect(blockAt(blocks, text.indexOf("theirs\n"))).toBe(a);
    expect(blockAt(blocks, 0)).toBeUndefined();
  });

  it("ignores unterminated markers", () => {
    expect(parseConflicts("<<<<<<< HEAD\nx\n=======\ny\n")).toEqual([]);
  });

  it("resolves blocks", () => {
    expect(resolveAll(text, "ours")).toBe("keep\nours 1\nours 2\ntail\n");
    expect(resolveAll(text, "theirs")).toBe("keep\ntheirs\ntail\nonly theirs\n");
    const [a] = parseConflicts(text);
    expect(resolutionText(a!, "both")).toBe("ours 1\nours 2\ntheirs\n");
    expect(resolutionText(a!, "base")).toBe("base\n");
  });
});
