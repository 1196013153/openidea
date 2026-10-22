/**
 * LSP-backed editor features: completion, diagnostics, hover / quick docs,
 * parameter info, navigation, document highlights, intentions, rename,
 * formatting, inlay hints and semantic highlighting. Everything is contributed
 * through `editor/api` as CodeMirror extensions plus actions; editor/core is
 * never imported.
 */
import type { Extension } from "@codemirror/state";
import { registerEditorContribution, type EditorDocContext } from "@/editor/api";
import { registerOverlay } from "@/workbench/contributions";
import { lspDoc } from "./lsp";
import { hintExtension } from "./hint";
import { completionExtension } from "./completion";
import { diagnosticsExtension, installDiagnosticsEvents } from "./diagnostics";
import { hoverExtension } from "./hover";
import { signatureExtension } from "./signature";
import { navigationExtension } from "./navigation";
import { intentionsExtension } from "./intentions";
import { inlayExtension } from "./inlay";
import { semanticExtension } from "./semantic";
import { usagesLensExtension } from "./codeLens";
import { autoImportExtension } from "./autoImport";
import { installAvailabilityEvents } from "./availability";
import { registerActionsOnSave, registerFormatOnSave, registerLspActions } from "./actions";
import { lspTheme } from "./theme";
import { inspectionWidgetExtension } from "./inspectionWidget";
import { LspPopups } from "./Popups";
import { prefetchMarkdown } from "./markdown";
import { registerNavigationActions } from "@/editor/navigation";

export function lspExtensions(ctx: EditorDocContext): Extension[] {
  return [
    lspDoc.of(ctx),
    lspTheme,
    hintExtension(),
    diagnosticsExtension(),
    inspectionWidgetExtension(),
    hoverExtension(),
    signatureExtension(),
    completionExtension(),
    navigationExtension(),
    intentionsExtension(),
    inlayExtension(),
    semanticExtension(),
    usagesLensExtension(),
    autoImportExtension(),
  ];
}

export function activate(): () => void {
  const disposers = [
    installDiagnosticsEvents(),
    installAvailabilityEvents(),
    registerEditorContribution({ id: "lsp", order: 50, extensions: lspExtensions }),
    registerOverlay({ id: "editor-lsp.popups", component: LspPopups }),
    registerLspActions(),
    registerNavigationActions(),
    registerFormatOnSave(),
    registerActionsOnSave(),
  ];
  prefetchMarkdown();
  return () => disposers.reverse().forEach((d) => d());
}
