import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { LspPopups } from "./Popups";
import { openPopup, useLspPopup } from "./popupStore";

function openUsagesDetected() {
  const view = vi.fn();
  const anyway = vi.fn();
  const cancel = vi.fn();
  act(() =>
    openPopup({
      kind: "choice",
      title: "Usages Detected",
      message: "Function 'unused' has 1 usage that is not safe to delete.",
      choices: [
        { label: "View Usages", primary: true, run: view },
        { label: "Delete Anyway", run: anyway },
        { label: "Cancel", run: cancel },
      ],
      onDismiss: cancel,
    }),
  );
  return { view, anyway, cancel };
}

const footerLabels = () =>
  [...screen.getByRole("dialog").querySelectorAll("[data-dialog-footer] button")].map((b) => b.textContent);

describe("Usages Detected dialog", () => {
  const os = usePlatform.getState().os;
  afterEach(() => {
    usePlatform.setState({ os });
    act(() => useLspPopup.setState({ popup: null }));
  });

  it("macOS: Cancel · Delete Anyway · View Usages (default rightmost, focused); Enter views usages", () => {
    usePlatform.setState({ os: "macos" });
    render(<LspPopups />);
    const { view } = openUsagesDetected();
    expect(footerLabels()).toEqual(["Cancel", "Delete Anyway", "View Usages"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "View Usages" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(view).toHaveBeenCalledTimes(1);
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("Windows: View Usages · Delete Anyway · Cancel; Escape and the close button cancel", () => {
    usePlatform.setState({ os: "windows" });
    render(<LspPopups />);
    let { cancel } = openUsagesDetected();
    expect(footerLabels()).toEqual(["View Usages", "Delete Anyway", "Cancel"]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);
    ({ cancel } = openUsagesDetected());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
