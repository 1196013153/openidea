import { expect, test } from "./fixtures";

test("⌘, opens Settings with the page tree; Escape closes", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  for (const name of ["Appearance & Behavior", "Keymap", "Editor", "Plugins", "Version Control"]) {
    await expect(dialog.getByRole("treeitem", { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Language Servers page installs a tool with progress (in-memory installer)", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  // The page tree is virtualized; search brings the page into view.
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Language Servers");
  await dialog.getByRole("treeitem", { name: "Language Servers", exact: true }).click();
  const table = dialog.getByRole("table", { name: /language servers/i });
  await expect(table).toBeVisible();

  const row = table.locator('tr[data-tool="gopls"]');
  await expect(row).toContainText("Missing");
  await row.getByRole("button", { name: "Install gopls" }).click();
  await expect(table.getByRole("progressbar", { name: "Installing gopls" })).toBeVisible();
  await expect(row).toContainText("Installed");
  await expect(row).toContainText("1.0.0");
  await expect(row.getByRole("button", { name: "Uninstall gopls" })).toBeVisible();

  // Tools without an installer explain how to get them.
  await expect(table).toContainText("gem install solargraph");
});
