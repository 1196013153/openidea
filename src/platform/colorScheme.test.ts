import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { _setSchemeSource, schemeCss, schemeTokens } from "./colorScheme";
import { validateEditorExtras } from "./editorSettings";

describe("color schemes", () => {
  beforeAll(() => _setSchemeSource(readFileSync("src/styles/tokens.css", "utf8")));
  it("reads resolved scheme tokens from tokens.css", () => {
    expect(schemeTokens("light").get("--syn-keyword")).toBe("#0033b3");
    expect(schemeTokens("dark").get("--syn-keyword")).toBe("#cf8e6d");
    expect(schemeTokens("light").get("--bg-editor")).not.toMatch(/var\(/);
  });

  it("emits scheme and override declarations", () => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    expect(schemeCss("theme-default", undefined, root)).toBe("");
    const dark = schemeCss("dark", undefined, root);
    expect(dark).toContain("--syn-keyword: #cf8e6d !important");
    const over = schemeCss("theme-default", { light: { keyword: { foreground: "#ff0000", bold: true } } }, root);
    expect(over).toContain("--syn-keyword: #ff0000 !important");
    expect(over).toContain("--syn-keyword-bold: 700 !important");
  });

  it("coerces editor settings to their defaults' shape", () => {
    const v = validateEditorExtras({ tabs: { tabLimit: "x", placement: "none" }, codeStyle: { languages: { go: { useTab: true } } } });
    expect(v.tabs.tabLimit).toBe(30);
    expect(v.tabs.placement).toBe("none");
    expect(v.codeStyle.languages.go).toEqual({ useTab: true });
    expect(v.general.softWrapFiles).toContain("*.md");
  });
});
