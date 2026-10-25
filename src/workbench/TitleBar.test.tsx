import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { useThemeOverride } from "./theme";
import { customizeToolbarItems, gearMenuItems, TitleBar } from "./TitleBar";

let disposers: Array<() => void> = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
  useThemeOverride.setState({ theme: null });
});

describe("title bar gear menu", () => {
  it("lists Run Anything, Settings, Plugins, quick switches, toolbar customization and Check for Updates", () => {
    const items = gearMenuItems("dark", "intellij-macos", ["Mine"]);
    expect(items.map((i) => ("action" in i ? i.action : "label" in i ? i.label : i.kind))).toEqual([
      "runAnything.show",
      "separator",
      "file.settings",
      "plugins.settings",
      "separator",
      "Theme",
      "Keymap",
      "View Mode",
      "separator",
      "Customize Main Toolbar",
      "separator",
      "app.checkForUpdates",
    ]);
    type Sub = { submenu: Array<{ label?: string; checked?: boolean; action?: string }> };
    const theme = (items[5] as Sub).submenu;
    expect(theme.filter((i) => i.checked).map((i) => i.label)).toEqual(["Islands Dark"]);
    const keymap = (items[6] as Sub).submenu;
    expect(keymap.map((i) => i.label)).toContain("Mine");
    expect(keymap.filter((i) => i.checked).map((i) => i.label)).toEqual(["macOS"]);
    // View Mode only switches the existing modes.
    expect((items[7] as Sub).submenu.map((i) => i.action)).toEqual(["editor.toggleZen", "window.toggleFullScreen"]);
  });

  it("lists every widget with a checkbox in Customize Main Toolbar", () => {
    const toggled: string[] = [];
    let reset = 0;
    const items = customizeToolbarItems(
      { left: ["project", "vcs.branch"], right: ["action:navigate.searchEverywhere"] },
      ["run.widget"],
      new Map([["run.widget", { id: "run.widget", align: "right", priority: 1, component: () => null, title: "Run Widget" }]]),
      (id) => toggled.push(id),
      () => void reset++,
    );
    const rows = items.filter((i): i is { id: string; label: string; checked: boolean; run: () => void } => "checked" in i);
    expect(rows.map((r) => [r.label, r.checked])).toEqual([
      ["Project Widget", true],
      ["VCS Widget", true],
      ["navigate.searchEverywhere", true],
      ["Run Widget", false],
    ]);
    rows[3]!.run();
    expect(toggled).toEqual(["run.widget"]);
    (items.at(-1) as { run: () => void }).run();
    expect(reset).toBe(1);
  });

  it("opens a menu instead of Settings directly, and switches the theme", async () => {
    let opened = 0;
    disposers.push(
      registerActions([{ id: "file.settings", title: "Settings…", category: "File", run: () => void opened++ }]),
    );
    render(<TitleBar />);
    fireEvent.click(screen.getByRole("button", { name: "IDE and Project Settings" }));
    expect(opened).toBe(0);
    expect(await screen.findByText("Settings…")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Theme"));
    fireEvent.click(await screen.findByText("High Contrast"));
    expect(useThemeOverride.getState().theme).toBe("dark-hc");
  });
});
