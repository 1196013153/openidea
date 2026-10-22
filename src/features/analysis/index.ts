/**
 * Code analysis: Inspect Code (batch language-server diagnostics), Locate
 * Duplicates and Search / Replace Structurally.
 */
import { registerActions } from "@/platform/actions";
import { registerOverlay, registerToolWindow } from "@/workbench/contributions";
import { showDuplicatesDialog, showInspectCodeDialog, showStructuralDialog } from "./AnalysisDialogs";
import { AnalysisDialogHost } from "./dialogs";
import { DuplicatesHeaderActions, DuplicatesView } from "./DuplicatesView";
import { InspectionHeaderActions, InspectionView } from "./InspectionView";

export function activate(): () => void {
  const disposers = [
    registerOverlay({ id: "analysis.dialogs", component: AnalysisDialogHost }),
    registerToolWindow({
      id: "inspection",
      title: "Inspection Results",
      icon: "toolwindow-inspection",
      anchor: "bottom",
      stripe: "onUse",
      order: 36,
      component: InspectionView,
      headerActions: InspectionHeaderActions,
    }),
    registerToolWindow({
      id: "duplicates",
      title: "Duplicates",
      icon: "toolwindow-duplicates",
      anchor: "bottom",
      stripe: "onUse",
      order: 37,
      component: DuplicatesView,
      headerActions: DuplicatesHeaderActions,
    }),
    registerActions([
      {
        id: "analyze.inspectCode",
        title: "Inspect Code…",
        category: "Code",
        icon: "toolwindow-inspection",
        when: "projectOpen",
        keywords: ["inspection", "analyze", "diagnostics", "problems"],
        run: () => void showInspectCodeDialog(),
      },
      {
        id: "analyze.locateDuplicates",
        title: "Locate Duplicates…",
        category: "Code",
        when: "projectOpen",
        keywords: ["duplicates", "clones", "copy paste", "cpd"],
        run: () => void showDuplicatesDialog(),
      },
      {
        id: "find.structural",
        title: "Search Structurally…",
        category: "Find",
        icon: "search",
        when: "projectOpen",
        keywords: ["ssr", "structural search", "pattern", "ast"],
        run: () => void showStructuralDialog(false),
      },
      {
        id: "find.replaceStructural",
        title: "Replace Structurally…",
        category: "Find",
        icon: "replace",
        when: "projectOpen",
        keywords: ["ssr", "structural replace", "pattern", "ast"],
        run: () => void showStructuralDialog(true),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
