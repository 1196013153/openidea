/**
 * Tools installer: Settings › Languages & Frameworks › Language Servers, plus
 * install prompts for missing language servers.
 *
 * Actions: `tools.languageServers` (open the page), `tools.install` (arg: tool name).
 */
import { lazyComponent } from "@/ui";
import { executeAction, registerActions } from "@/platform/actions";
import { registerSettingsPage } from "@/workbench/contributions";
import { installMissingServerPrompts } from "./missing";
import { installTool, SETTINGS_PAGE_ID } from "./store";

/** The Language Servers page (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE_ID,
    title: "Language Servers",
    group: "Languages & Frameworks",
    order: 400,
    keywords: ["lsp", "language server", "debugger", "adapter", "dap", "install", "rust-analyzer", "gopls", "pyright"],
    component: lazyComponent(() => import("./LanguageServersPage").then((m) => m.LanguageServersPage)),
  });
}

export function activate(): () => void {
  const disposers = [
    activateSettingsPages(),
    registerActions([
      {
        id: "tools.languageServers",
        title: "Language Servers…",
        category: "Tools",
        icon: "package",
        keywords: ["lsp", "install", "debugger", "adapter"],
        run: () => void executeAction("file.settings", SETTINGS_PAGE_ID),
      },
      {
        id: "tools.install",
        title: "Install Language Server / Debugger",
        category: "Tools",
        hidden: true,
        run: async ({ arg }) => {
          if (typeof arg === "string") await installTool(arg);
          else await executeAction("file.settings", SETTINGS_PAGE_ID);
        },
      },
    ]),
    installMissingServerPrompts(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
