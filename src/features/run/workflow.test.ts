import { describe, expect, it } from "vitest";
import { ConsoleModel } from "./console";
import { foldRows } from "./ConsoleView";
import { expandMacros, toolRunConfig } from "./externalTools";
import { DEFAULT_EXTERNAL_TOOL } from "@/platform/workflowSettings";

const ctx = {
  projectRoot: "/p",
  projectName: "demo",
  filePath: "/p/src/main.rs",
  line: 3,
  column: 5,
  selectedText: "sel",
};

describe("console settings", () => {
  it("keeps the cycle buffer under the character limit", () => {
    const m = new ConsoleModel({ maxChars: 100 });
    for (let i = 0; i < 50; i++) m.append({ kind: "stdout", text: `line ${i}\n` });
    const chars = m.lines.reduce((n, l) => n + l.text.length + 1, 0);
    expect(chars).toBeLessThanOrEqual(100);
    expect(m.lines.at(-1)?.text).toBe("line 49");
    expect(m.text()).toContain("line 49");
    expect(m.dropped).toBeGreaterThan(0);
  });

  it("folds runs of matching lines", () => {
    const m = new ConsoleModel();
    m.append({ kind: "stderr", text: "Error\n  at org.junit.A\n  at org.junit.B\n  at app.Main\n  at org.junit.C\n" });
    const rows = foldRows(m.lines, ["at org.junit."], new Set());
    expect(rows.map((r) => (r.kind === "fold" ? `fold${r.count}` : m.lines[r.index]!.text.trim()))).toEqual([
      "Error",
      "fold2",
      "at app.Main",
      "at org.junit.C",
    ]);
    const fold = rows.find((r) => r.kind === "fold")!;
    expect(foldRows(m.lines, ["at org.junit."], new Set([fold.kind === "fold" ? fold.id : 0])).length).toBe(5);
  });
});

describe("external tools", () => {
  it("expands IDEA macros", () => {
    expect(expandMacros("$FileName$ $FileNameWithoutExtension$ $FileExt$ $FileRelativePath$", ctx)).toBe(
      "main.rs main rs src/main.rs",
    );
    expect(expandMacros("$ProjectFileDir$:$LineNumber$:$ColumnNumber$ $Unknown$ $Prompt$", ctx, "x")).toBe("/p:3:5 $Unknown$ x");
  });

  it("builds a run configuration with per-argument expansion", () => {
    const tool = { ...DEFAULT_EXTERNAL_TOOL, id: "t", name: "Fmt", program: "rustfmt", arguments: `--edition 2021 "$FilePath$"` };
    expect(toolRunConfig(tool, { ...ctx, filePath: "/p/my dir/a.rs" })).toMatchObject({
      id: "external:t",
      command: "rustfmt",
      args: ["--edition", "2021", "/p/my dir/a.rs"],
      cwd: "/p",
    });
  });
});
