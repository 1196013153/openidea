import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBinding, installKeyboardDispatcher, normalizeBinding, strokeOf, useKeymap } from "./keymap";
import { executeAction, registerAction } from "./actions";

describe("keymap", () => {
  it("normalizes modifier order and case", () => {
    expect(normalizeBinding("Shift+Meta+o")).toBe("Shift+Meta+O");
    expect(normalizeBinding("meta+K  meta+c")).toBe("Meta+K Meta+C");
  });

  it("formats macOS style", () => {
    expect(formatBinding("Meta+Shift+O")).toBe("⇧⌘O");
    expect(formatBinding("Alt+Enter")).toBe("⌥↵");
    expect(formatBinding("Shift Shift")).toBe("⇧⇧");
  });

  it("uses physical key codes", () => {
    expect(strokeOf({ code: "KeyF", key: "ƒ", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })).toBe(
      "Alt+F",
    );
    expect(
      strokeOf({ code: "ShiftLeft", key: "Shift", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }),
    ).toBeNull();
  });

  describe("dispatcher", () => {
    let uninstall = () => {};
    afterEach(() => uninstall());

    it("runs bound actions and chords", async () => {
      const single = vi.fn();
      const chord = vi.fn();
      registerAction({ id: "t.single", title: "single", run: single });
      registerAction({ id: "t.chord", title: "chord", run: chord });
      useKeymap.setState({ overrides: { "t.single": ["Meta+J"], "t.chord": ["Meta+K Meta+C"] } });
      uninstall = installKeyboardDispatcher(window);
      const press = (code: string, init: KeyboardEventInit) =>
        window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, ...init }));
      press("KeyJ", { key: "j", metaKey: true });
      press("KeyK", { key: "k", metaKey: true });
      press("KeyC", { key: "c", metaKey: true });
      await Promise.resolve();
      expect(single).toHaveBeenCalledOnce();
      expect(chord).toHaveBeenCalledOnce();
    });

    it("respects when clauses", async () => {
      const run = vi.fn();
      registerAction({ id: "t.gated", title: "gated", when: "never", run });
      useKeymap.setState({ overrides: { "t.gated": ["Meta+G"] } });
      uninstall = installKeyboardDispatcher(window);
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyG", key: "g", metaKey: true }));
      await Promise.resolve();
      expect(run).not.toHaveBeenCalled();
    });

    it("applies keyWhen to shortcuts only", async () => {
      const run = vi.fn();
      registerAction({ id: "t.keyGated", title: "keyGated", keyWhen: "never", run });
      useKeymap.setState({ overrides: { "t.keyGated": ["Meta+H"] } });
      uninstall = installKeyboardDispatcher(window);
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyH", key: "h", metaKey: true }));
      await Promise.resolve();
      expect(run).not.toHaveBeenCalled();
      expect(await executeAction("t.keyGated")).toBe(true);
      expect(run).toHaveBeenCalledOnce();
    });
  });
});
