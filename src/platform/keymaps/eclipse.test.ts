import { describe, expect, it } from "vitest";
import { isValidBinding, normalizeBinding, PRESET_TITLES, PRESETS } from "../keymap";
import { eclipseMacos } from "./eclipse-macos";
import { eclipseWindows } from "./eclipse-windows";
import { intellijMacos } from "./intellij-macos";
import { intellijWindows } from "./intellij-windows";

type Keymap = Record<string, string[]>;

const presets: Array<[string, Keymap, Keymap]> = [
  ["eclipse-macos", eclipseMacos, intellijMacos],
  ["eclipse-windows", eclipseWindows, intellijWindows],
];

/** Ids whose bindings the Eclipse preset changes on top of IntelliJ. */
const overridden = (km: Keymap, base: Keymap) =>
  Object.keys(km).filter((id) => JSON.stringify(km[id]) !== JSON.stringify(base[id]));

/**
 * Actions that only take a key in their own context (tool window / tree / popup
 * / diff / search field / debugger view / commit view focus), so they may share
 * a key with an editor action even when listed later.
 */
const SCOPED =
  /^(project\.|db\.|diff\.|find\.popup\.|find\.field\.|services\.|terminal\.new$|vcs\.changelist\.|vcs\.showDiff$|vcs\.showMessageHistory$|debug\.setValue$|debug\.jumpToSource$)/;

describe("Eclipse keymaps", () => {
  it("are registered with their titles", () => {
    expect(PRESETS["eclipse-macos"]).toBe(eclipseMacos);
    expect(PRESETS["eclipse-windows"]).toBe(eclipseWindows);
    expect(PRESET_TITLES["eclipse-macos"]).toBe("Eclipse (macOS)");
    expect(PRESET_TITLES["eclipse-windows"]).toBe("Eclipse (Windows)");
  });

  it.each(presets)("%s only uses action ids of its IntelliJ base, with valid bindings", (_, km, base) => {
    expect(Object.keys(km).filter((id) => !(id in base))).toEqual([]);
    expect(Object.keys(km)).toEqual(Object.keys(base));
    for (const [id, keys] of Object.entries(km))
      for (const k of keys) expect(isValidBinding(k), `${id}: ${k}`).toBe(true);
  });

  it("never binds the Windows key on Windows", () => {
    expect(Object.entries(eclipseWindows).filter(([, keys]) => keys.some((k) => /\bMeta\b/.test(k)))).toEqual([]);
  });

  it.each([
    ["navigate.gotoClass", ["Meta+Shift+T"], ["Ctrl+Shift+T"]],
    ["navigate.gotoFile", ["Meta+Shift+R"], ["Ctrl+Shift+R"]],
    ["navigate.fileStructure", ["Meta+O", "Meta+F12"], ["Ctrl+O", "Ctrl+F12"]],
    ["navigate.declaration", ["F3", "Meta+B"], ["F3", "Ctrl+B"]],
    ["navigate.typeHierarchy", ["Meta+T", "F4"], ["Ctrl+T", "F4"]],
    ["navigate.lastEditLocation", ["Ctrl+Q", "Meta+Shift+Backspace"], ["Ctrl+Q", "Ctrl+Shift+Backspace"]],
    ["code.showIntentions", ["Meta+1", "Alt+Enter"], ["Ctrl+1", "Alt+Enter"]],
    ["code.deleteLine", ["Meta+D"], ["Ctrl+D"]],
    ["code.duplicateLine", ["Meta+Alt+Down"], ["Ctrl+Alt+Down"]],
    ["code.moveLineUp", ["Alt+Up"], ["Alt+Up"]],
    ["code.extendSelection", ["Alt+Shift+Up"], ["Alt+Shift+Up"]],
    ["code.reformat", ["Meta+Shift+F"], ["Ctrl+Shift+F"]],
    ["code.optimizeImports", ["Meta+Shift+O"], ["Ctrl+Shift+O"]],
    ["refactor.rename", ["Meta+Alt+R", "Shift+F6"], ["Alt+Shift+R", "Shift+F6"]],
    ["refactor.extractVariable", ["Meta+Alt+L"], ["Alt+Shift+L"]],
    ["refactor.inline", ["Meta+Alt+I"], ["Alt+Shift+I"]],
    ["find.inPath", ["Ctrl+H"], ["Ctrl+H"]],
    ["find.usages", ["Meta+Shift+G", "Alt+F7"], ["Ctrl+Shift+G", "Alt+F7"]],
    ["find.next", ["Meta+K", "Meta+G"], ["Ctrl+K", "Ctrl+L"]],
    ["editor.matchBrace", ["Meta+Shift+P", "Ctrl+M"], ["Ctrl+Shift+P", "Ctrl+Shift+M"]],
    ["debug.stepInto", ["F5"], ["F5"]],
    ["debug.stepOver", ["F6"], ["F6"]],
    ["debug.stepOut", ["F7"], ["F7"]],
    ["debug.resume", ["F8"], ["F8"]],
    ["debug.toggleBreakpoint", ["Meta+Shift+B"], ["Ctrl+Shift+B"]],
    ["run.run", ["Meta+Shift+F11", "Ctrl+R"], ["Ctrl+F11", "Shift+F10"]],
    ["run.debug", ["Meta+F11", "Ctrl+D"], ["F11", "Shift+F9"]],
    // Moved off Eclipse's Find Next / Type Hierarchy keys.
    ["vcs.update", ["Ctrl+Alt+U"], ["Ctrl+Alt+U"]],
  ])("%s", (id, mac, win) => {
    expect(eclipseMacos[id]).toEqual(mac);
    expect(eclipseWindows[id]).toEqual(win);
  });

  // The dispatcher runs the last enabled action of a key, so a globally enabled
  // action listed after an Eclipse binding would take the key from it.
  it.each(presets)("%s keeps Eclipse keys from later unscoped actions", (_, km, base) => {
    const ids = Object.keys(km);
    const stolen: string[] = [];
    for (const id of overridden(km, base)) {
      for (const key of km[id]!.map(normalizeBinding)) {
        for (const other of ids.slice(ids.indexOf(id) + 1)) {
          if (SCOPED.test(other) || overridden(km, base).includes(other)) continue;
          if (km[other]!.map(normalizeBinding).includes(key)) stolen.push(`${key}: ${id} ← ${other}`);
        }
      }
    }
    expect(stolen).toEqual([]);
  });
});
