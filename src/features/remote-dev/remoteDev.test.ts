import { describe, expect, it } from "vitest";
import type { RemoteEntry } from "@/platform/ipc";
import { browsableFolders, listedDirectory, remoteParent } from "./model";

const entry = (path: string, isDir = true): RemoteEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir,
  isSymlink: false,
  size: 0,
  mtime: null,
  permissions: "rwxr-xr-x",
});

describe("remote folder browser", () => {
  it("goes up one level and stops at the root", () => {
    expect(remoteParent("/home/dev/app")).toBe("/home/dev");
    expect(remoteParent("/home/dev/")).toBe("/home");
    expect(remoteParent("/home")).toBe("/");
    expect(remoteParent("/")).toBe("/");
  });

  it("lists folders only, hidden ones last", () => {
    const names = browsableFolders([
      entry("/h/.cache"),
      entry("/h/zeta"),
      entry("/h/notes.txt", false),
      entry("/h/alpha"),
    ]).map((e) => e.name);
    expect(names).toEqual(["alpha", "zeta", ".cache"]);
  });

  it("resolves `~` from the listing", () => {
    expect(listedDirectory("~", [entry("/home/dev/app")])).toBe("/home/dev");
    expect(listedDirectory("~", [])).toBe("~");
    expect(listedDirectory("/srv/", [])).toBe("/srv");
    expect(listedDirectory("/", [])).toBe("/");
  });
});
