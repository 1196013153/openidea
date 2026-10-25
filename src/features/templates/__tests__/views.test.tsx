import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { LiveTemplatesPage, groupTemplates } from "../settings/LiveTemplatesPage";
import { PostfixPage } from "../settings/PostfixPage";
import { FileTemplatesPage } from "../settings/FileTemplatesPage";
import { NewFileDialogHost, openNewFileDialog } from "../files/NewFileDialog";
import { ChooserHost } from "../popup/Chooser";
import { showChooser } from "../popup/store";
import { BUILTIN_TEMPLATES } from "../live/builtins";
import { useLiveTemplates } from "../live/store";
import { usePostfixSettings } from "../postfix/store";

describe("settings pages", () => {
  it("groups and filters live templates", () => {
    const groups = groupTemplates(BUILTIN_TEMPLATES, "psvm");
    expect(groups.map(([g]) => g)).toEqual(["Java"]);
  });

  it("edits a live template", () => {
    render(<LiveTemplatesPage />);
    fireEvent.click(screen.getAllByText("psvm")[0]!);
    const desc = screen.getByLabelText("Description") as HTMLInputElement;
    fireEvent.change(desc, { target: { value: "Main method" } });
    expect(useLiveTemplates.getState().templates.find((t) => t.id === "java.psvm")?.description).toBe("Main method");
    expect(screen.getByText("Restore Default")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Restore Default"));
    expect(useLiveTemplates.getState().templates.find((t) => t.id === "java.psvm")?.description).toBe("main() method");
  });

  it("toggles postfix templates", () => {
    render(<PostfixPage />);
    fireEvent.click(screen.getByLabelText("Enable .if"));
    expect(usePostfixSettings.getState().disabled).toContain("ts.if");
    fireEvent.click(screen.getByLabelText("Enable .if"));
    expect(usePostfixSettings.getState().disabled).not.toContain("ts.if");
  });

  it("renders file templates", () => {
    render(<FileTemplatesPage />);
    expect(screen.getByText("Kotlin Class/File")).toBeInTheDocument();
  });
});

describe("dialogs", () => {
  it("shows the template chooser then the name step", () => {
    render(<NewFileDialogHost />);
    act(() => openNewFileDialog({ directory: "/p/src/main/kotlin/com/acme" }));
    fireEvent.click(screen.getByText("Kotlin Class/File"));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByText("Data class")).toBeInTheDocument();
  });

  it("chooser filters by typing and picks with Enter", () => {
    let picked = "";
    render(<ChooserHost />);
    act(() =>
      showChooser({
        title: "Test",
        anchor: { x: 0, y: 0 },
        filterable: true,
        items: [
          { key: "a", label: "fori" },
          { key: "b", label: "iter" },
        ],
        onPick: (i) => (picked = i.key),
      }),
    );
    const body = screen.getByRole("dialog").querySelector("[tabindex='0']")!;
    fireEvent.keyDown(body, { key: "i" });
    fireEvent.keyDown(body, { key: "t" });
    fireEvent.keyDown(body, { key: "Enter" });
    expect(picked).toBe("b");
  });

  it("chooser picks by mnemonic and skips section rows", () => {
    let picked = "";
    render(<ChooserHost />);
    act(() =>
      showChooser({
        title: "Surround With",
        anchor: { x: 0, y: 0 },
        mnemonics: true,
        items: [
          { key: "if", label: "if", mnemonic: "1" },
          { key: "s", label: "Live templates", section: true },
          { key: "t", label: "T", detail: "tag", mnemonic: "T", mnemonicIndex: 0 },
        ],
        onPick: (i) => (picked = i.key),
      }),
    );
    const body = screen.getByRole("dialog").querySelector("[tabindex='0']")!;
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: "Enter" });
    expect(picked).toBe("t");
    act(() =>
      showChooser({
        title: "Surround With",
        anchor: { x: 0, y: 0 },
        mnemonics: true,
        items: [
          { key: "if", label: "if", mnemonic: "1" },
          { key: "t", label: "T", mnemonic: "T", mnemonicIndex: 0 },
        ],
        onPick: (i) => (picked = i.key),
      }),
    );
    fireEvent.keyDown(screen.getByRole("dialog").querySelector("[tabindex='0']")!, { key: "t" });
    expect(picked).toBe("t");
  });
});
