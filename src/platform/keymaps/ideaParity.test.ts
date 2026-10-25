import { describe, expect, it } from "vitest";
import { intellijMacos } from "./intellij-macos";
import { intellijWindows } from "./intellij-windows";

/** Bindings checked against IDEA's `$default.xml` (Windows) and `Mac OS X 10.5+.xml`. */
describe("IDEA keymap parity", () => {
  it.each([
    ["code.splitLine", ["Meta+Enter"], ["Ctrl+Enter"]],
    ["editor.scrollToCenter", ["Ctrl+L"], ["Ctrl+M"]],
    ["editor.codeBlockStart", ["Meta+Alt+["], ["Ctrl+["]],
    ["editor.codeBlockEnd", ["Meta+Alt+]"], ["Ctrl+]"]],
    ["view.zoomIn", ["Ctrl+Alt+="], ["Alt+Shift+="]],
    ["view.zoomOut", ["Ctrl+Alt+-"], ["Alt+Shift+-"]],
    ["view.resetZoom", ["Ctrl+Alt+0"], ["Alt+Shift+0"]],
    ["vcs.changelist.move", ["Meta+Shift+M"], ["Alt+Shift+M"]],
    ["vcs.changelist.edit", ["F2", "Shift+F6"], ["F2", "Shift+F6"]],
    ["code.quickDocumentation", ["F1", "Ctrl+J"], ["Ctrl+Q"]],
    // Git.Branches: the macOS keymaps remove ⇧⌘` (it cycles windows there).
    ["vcs.branches", [], ["Ctrl+Shift+`"]],
    ["debug.resume", ["Meta+Alt+R", "F9"], ["F9"]],
    ["code.quickDefinition", ["Alt+Space", "Meta+Y"], ["Ctrl+Shift+I"]],
    ["editor.copyPath", ["Meta+Shift+C"], ["Ctrl+Shift+C"]],
    ["project.open", ["F4", "Meta+Down"], ["F4"]],
    ["project.delete", ["Delete", "Backspace", "Meta+Backspace"], ["Delete"]],
    ["file.reloadFromDisk", ["Meta+Alt+Y"], ["Ctrl+Alt+Y"]],
    ["project.reloadFromDisk", ["Meta+Alt+Y"], ["Ctrl+Alt+Y"]],
    ["project.expandAll", ["Meta+="], ["Ctrl+="]],
    ["project.collapseAll", ["Meta+-"], ["Ctrl+-"]],
    ["navigate.searchText", ["Meta+Alt+Shift+E"], ["Ctrl+Alt+Shift+E"]],
    ["window.next", ["Meta+Alt+`"], ["Ctrl+Alt+]"]],
    ["window.previous", ["Meta+Alt+Shift+`"], ["Ctrl+Alt+["]],
    ["code.commentBlock", ["Meta+Alt+/", "Ctrl+Shift+/"], ["Ctrl+Shift+/"]],
    ["navigate.typeDeclaration", ["Meta+Shift+B", "Ctrl+Shift+B"], ["Ctrl+Shift+B"]],
    ["find.next", ["Meta+G"], ["F3", "Ctrl+L"]],
    ["find.previous", ["Meta+Shift+G"], ["Shift+F3", "Ctrl+Shift+L"]],
    ["project.copy", ["Meta+C"], ["Ctrl+C", "Ctrl+Insert"]],
    ["project.cut", ["Meta+X"], ["Ctrl+X", "Shift+Delete"]],
    ["project.paste", ["Meta+V"], ["Ctrl+V", "Shift+Insert"]],
  ])("%s", (id, mac, win) => {
    expect(intellijMacos[id]).toEqual(mac);
    expect(intellijWindows[id]).toEqual(win);
  });

  // Later entries win a shared key while their `when` / `keyWhen` holds.
  const order = (km: Record<string, string[]>, earlier: string, later: string) => {
    const ids = Object.keys(km);
    expect(ids.indexOf(earlier), `${earlier} before ${later}`).toBeLessThan(ids.indexOf(later));
  };

  it.each([intellijMacos, intellijWindows])("lets scoped actions win shared keys", (km) => {
    order(km, "code.splitLine", "http.runRequest");
    order(km, "code.splitLine", "db.execute");
    order(km, "editor.copyPath", "project.copyAbsolutePath");
    order(km, "file.reloadFromDisk", "project.reloadFromDisk");
    order(km, "code.unfold", "project.expandAll");
    order(km, "code.fold", "project.collapseAll");
    order(km, "navigate.nextError", "vcs.changelist.edit");
    order(km, "debug.setValue", "vcs.changelist.edit");
  });
});
