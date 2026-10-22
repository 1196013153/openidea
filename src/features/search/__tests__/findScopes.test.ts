import { describe, expect, it } from "vitest";
import { FILE_SET_SCOPES, buildQuery, describeQuery, useFindPopup } from "../find/store";

describe("Find in Files named scopes", () => {
  it("defaults to IDEA's Project Files and maps root-based scopes to backend file sets", () => {
    expect(useFindPopup.getState().namedScope).toBe("projectFiles");
    expect(FILE_SET_SCOPES).toEqual({ projectFiles: "all", productionFiles: "production", testFiles: "test" });
    const q = buildQuery(useFindPopup.getState(), { kind: "fileSet", set: "test" }, 0);
    expect(q.scope).toEqual({ kind: "fileSet", set: "test" });
    expect(describeQuery({ ...q, pattern: "x" }, "/p")).toBe("'x' in Project Test Files");
    expect(describeQuery({ ...q, pattern: "x", scope: { kind: "fileSet", set: "production" } }, "/p")).toBe(
      "'x' in Project Production Files",
    );
  });
});
