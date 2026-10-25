import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { useThemeOverride } from "./theme";
import { gearMenuItems, TitleBar } from "./TitleBar";

let disposers: Array<() => void> = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
  useThemeOverride.setState({ theme: null });
});

describe("title bar gear menu", () => {
  it("lists Settings, Plugins, Theme and Keymap switches and Check for Updates", () => {
    const items = gearMenuItems("dark", "intellij-macos", ["Mine"]);
    expect(items.map((i) => ("action" in i ? i.action : "label" in i ? i.label : i.kind))).toEqual([
      "file.settings",
      "plugins.settings",
      "separator",
      "Theme",
      "Keymap",
      "separator",
      "app.checkForUpdates",
    ]);
    const theme = (items[3] as { submenu: Array<{ label?: string; checked?: boolean }> }).submenu;
    expect(theme.filter((i) => i.checked).map((i) => i.label)).toEqual(["Islands Dark"]);
    const keymap = (items[4] as { submenu: Array<{ label?: string; checked?: boolean }> }).submenu;
    expect(keymap.map((i) => i.label)).toContain("Mine");
    expect(keymap.filter((i) => i.checked).map((i) => i.label)).toEqual(["macOS"]);
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
