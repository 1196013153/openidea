import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Settings } from "@/platform/ipc";

const settingsSet = vi.fn();
const settingsGet = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      settingsSet: (...a: unknown[]) => settingsSet(...a),
      settingsGet: () => settingsGet(),
    },
  };
});

import { registerAction, executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { useKeymap } from "@/platform/keymap";
import { ContextMenuHost } from "@/ui";
import { DEFAULT_SETTINGS, setAt } from "../model/schema";
import { useSettingsDialog } from "../model/staging";
import { SettingsDialog } from "../dialog/SettingsDialog";
import { activate } from "..";
import { MessagesHost } from "@/workbench/messages";

let current: Settings;
let dispose: () => void = () => {};

beforeEach(() => {
  current = structuredClone(DEFAULT_SETTINGS) as Settings;
  settingsSet.mockReset().mockImplementation(async (_scope: string, key: string, json: string) => {
    current = setAt(current, key, JSON.parse(json));
    return { status: "ok", data: current };
  });
  settingsGet.mockReset().mockImplementation(async () => current);
  useProject.setState({ settings: current, project: null });
  dispose = activate();
});

afterEach(() => {
  act(() => useSettingsDialog.setState({ open: false }));
  dispose();
});

async function openDialog(page?: string) {
  render(
    <>
      <SettingsDialog />
      <MessagesHost />
    </>,
  );
  await act(async () => {
    await executeAction("file.settings", page);
  });
  return screen.getByRole("dialog", { name: "Settings" });
}

describe("Settings dialog", () => {
  it("searches pages and highlights matching option labels", async () => {
    const dialog = await openDialog("appearance");
    fireEvent.change(within(dialog).getByLabelText("Search settings"), { target: { value: "soft wrap" } });
    const tree = within(dialog).getByRole("tree", { name: "Settings pages" });
    expect(within(tree).getByText("General")).toBeInTheDocument();
    expect(within(tree).queryByText("Keymap")).toBeNull();
    // The matching page is selected and its option label is highlighted.
    const option = within(dialog).getByRole("checkbox", { name: /Soft-wrap files/ });
    expect(option.closest("[data-search-match]")).not.toBeNull();
    expect(dialog.querySelectorAll("mark").length).toBeGreaterThan(0);
  });

  it("stages edits and writes them on Apply", async () => {
    const dialog = await openDialog("editor.general");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Soft-wrap files/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Reformat code on save/ }));
    expect(settingsSet).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    });
    expect(settingsSet.mock.calls).toEqual([
      ["global", "editor.formatOnSave", "true"],
      ["global", "editor.softWrap", "false"],
    ]);
    expect(settingsGet).toHaveBeenCalled();
    expect(useProject.getState().settings?.editor?.softWrap).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("Cancel discards staged edits", async () => {
    const dialog = await openDialog("editor.codeStyle.other");
    fireEvent.change(within(dialog).getByLabelText("Tab size"), { target: { value: "2" } });
    expect(Object.keys(useSettingsDialog.getState().staged)).toEqual(["global|editor.tabSize"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(settingsSet).not.toHaveBeenCalled();
    expect(useSettingsDialog.getState().open).toBe(false);
  });

  it("records a shortcut, shows conflicts and applies it to the keymap on OK", async () => {
    registerAction({
      id: "code.duplicateLine",
      title: "Duplicate Line",
      category: "Code",
      when: "editorFocus",
      run: () => {},
    });
    registerAction({ id: "t.mine", title: "My Action", category: "Code", when: "editorFocus", run: () => {} });
    const dialog = await openDialog("keymap");
    const row = within(dialog).getByText("My Action");
    fireEvent.doubleClick(row);
    const recorder = await screen.findByRole("dialog", { name: /Keyboard Shortcut: My Action/ });
    const first = within(recorder).getByRole("textbox", { name: "First stroke" });
    fireEvent.keyDown(first, { code: "KeyD", key: "d", metaKey: true });
    expect(within(recorder).getByText("Duplicate Line")).toBeInTheDocument();
    fireEvent.click(within(recorder).getByRole("button", { name: "OK" }));
    const warning = await screen.findByRole("dialog", { name: "Warning" });
    expect(within(warning).getByText(/already assigned to other actions/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(warning).getByRole("button", { name: "Leave" }));
    });
    expect(useSettingsDialog.getState().staged["global|keymapOverrides"]?.value).toEqual({ "t.mine": ["Meta+D"] });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    });
    expect(settingsSet).toHaveBeenCalledWith("global", "keymapOverrides", '{"t.mine":["Meta+D"]}');
    expect(useKeymap.getState().overrides).toEqual({ "t.mine": ["Meta+D"] });
    expect(useSettingsDialog.getState().open).toBe(false);
  });

  it("duplicates the keymap from the gear menu and edits the copy", async () => {
    render(<ContextMenuHost />);
    registerAction({ id: "t.dup", title: "Dup Target", category: "Code", run: () => {} });
    const dialog = await openDialog("keymap");
    fireEvent.click(within(dialog).getByRole("button", { name: "Show Scheme Actions" }));
    fireEvent.click(await screen.findByText("Duplicate…"));
    const named = await screen.findByRole("dialog", { name: "Duplicate Keymap" });
    expect(within(named).getByRole("textbox")).toHaveValue("macOS copy");
    fireEvent.click(within(named).getByRole("button", { name: "OK" }));
    const staged = useSettingsDialog.getState().staged;
    expect(staged["global|keymap"]?.value).toBe("custom.macos-copy");
    expect(staged["global|customKeymaps"]?.value).toEqual({
      "custom.macos-copy": { name: "macOS copy", parent: "intellij-macos", overrides: {} },
    });
    fireEvent.doubleClick(within(dialog).getByText("Dup Target"));
    const recorder = await screen.findByRole("dialog", { name: /Keyboard Shortcut: Dup Target/ });
    fireEvent.keyDown(within(recorder).getByRole("textbox", { name: "First stroke" }), {
      code: "F9",
      key: "F9",
      shiftKey: true,
      altKey: true,
      metaKey: true,
      ctrlKey: true,
    });
    fireEvent.click(within(recorder).getByRole("button", { name: "OK" }));
    const after = useSettingsDialog.getState().staged;
    expect(after["global|customKeymaps"]?.value).toEqual({
      "custom.macos-copy": {
        name: "macOS copy",
        parent: "intellij-macos",
        overrides: { "t.dup": ["Ctrl+Alt+Shift+Meta+F9"] },
      },
    });
    expect(after["global|keymapOverrides"]).toBeUndefined();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    });
    expect(useKeymap.getState().preset).toBe("intellij-macos");
    expect(useKeymap.getState().overrides).toEqual({ "t.dup": ["Ctrl+Alt+Shift+Meta+F9"] });
  });

  it("survives invalid settings values", async () => {
    act(() =>
      useProject.setState({
        settings: { appearance: { theme: 42, uiFontSize: "x" }, keymapOverrides: { a: "b" } } as unknown as Settings,
      }),
    );
    const dialog = await openDialog("appearance");
    expect(within(dialog).getByRole("button", { name: "Theme" })).toHaveTextContent("Islands Light");
    expect(within(dialog).getByLabelText("UI font size")).toHaveValue("13");
  });
});
