import { describe, expect, it } from "vitest";
import { menuItems } from "./MainMenu";

describe("main menu model", () => {
  it("maps menu nodes to menu items, localising spec labels only", () => {
    const items = menuItems([
      { kind: "action", id: "file.save", label: "Save All", hint: null, arg: null },
      { kind: "separator" },
      {
        kind: "submenu",
        id: "openRecent",
        label: "Open Recent",
        children: [
          { kind: "action", id: "file.openRecentProject", label: "openidea  —  ~/openidea", hint: null, arg: "/p/openidea" },
          { kind: "placeholder", id: "recent.none", label: "No Recent Projects" },
        ],
      },
    ]);
    expect(items[0]).toEqual({ kind: "action", action: "file.save", arg: undefined, label: "Save All" });
    expect(items[1]).toEqual({ kind: "separator" });
    expect(items[2]).toMatchObject({ id: "openRecent", label: "Open Recent" });
    const sub = (items[2] as { submenu: unknown[] }).submenu;
    expect(sub[0]).toEqual({
      kind: "action",
      action: "file.openRecentProject",
      arg: "/p/openidea",
      label: "openidea  —  ~/openidea",
    });
    expect(sub[1]).toMatchObject({ label: "No Recent Projects", disabled: true });
  });
});
