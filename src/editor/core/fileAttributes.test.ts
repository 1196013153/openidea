import { beforeEach, describe, expect, it, vi } from "vitest";
import { closePopup, useLspPopup } from "@/editor/lsp/popupStore";
import type { DocModel } from "./model/document";
import { readOnlyQuestion, toggleReadOnly } from "./fileAttributes";

function model(readOnly: boolean, extra: Partial<{ virtual: boolean; banner: string | null }> = {}) {
  const meta = { readOnly, banner: extra.banner ?? (readOnly ? "readOnly" : null) };
  return {
    path: "/p/a.txt",
    virtual: extra.virtual ?? false,
    getMeta: () => meta,
    setReadOnly: vi.fn((ro: boolean) => void (meta.readOnly = ro)),
  } as unknown as DocModel & { setReadOnly: ReturnType<typeof vi.fn> };
}

beforeEach(() => closePopup());

describe("Toggle Read-only Attribute", () => {
  it("asks before making a read-only file writable, then toggles", async () => {
    const m = model(true);
    toggleReadOnly(m);
    const popup = useLspPopup.getState().popup;
    expect(popup).toMatchObject({ kind: "choice", title: "Make File Writable" });
    if (popup?.kind !== "choice") throw new Error("no choice");
    expect(popup.choices.map((c) => c.label)).toEqual(["Make Writable", "Cancel"]);
    popup.choices[0]!.run();
    await vi.waitFor(() => expect(m.setReadOnly).toHaveBeenCalledWith(false));
  });

  it("Cancel leaves the file alone", () => {
    const m = model(false);
    toggleReadOnly(m);
    const popup = useLspPopup.getState().popup;
    if (popup?.kind !== "choice") throw new Error("no choice");
    expect(popup.title).toBe("Make File Read-only");
    popup.choices[1]!.run();
    expect(m.setReadOnly).not.toHaveBeenCalled();
  });

  it("does nothing for library and binary documents", () => {
    toggleReadOnly(model(true, { virtual: true }));
    toggleReadOnly(model(true, { banner: "binary" }));
    expect(useLspPopup.getState().popup).toBeNull();
    expect(readOnlyQuestion("a.txt", false).confirm).toBe("Make Read-only");
  });
});
