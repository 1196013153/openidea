/**
 * Run with Coverage (IDEA's third executor beside Run and Debug): runs a
 * configuration under its runtime's coverage tool, then shows the report in
 * the Coverage tool window, as editor gutter stripes and as project tree badges.
 */
import { registerEditorContribution } from "@/editor/api";
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerRunExecutor, registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { CoverageHeaderActions, CoverageTabs, CoverageView } from "./CoverageView";
import { coverageExecutor } from "./executor";
import { coverageGutter } from "./gutter";
import { resetCoverage, setCoverageVisible, syncCoverageViews, useCoverage } from "./store";

export function activate(): () => void {
  const disposers: Array<() => void> = [
    registerRunExecutor(coverageExecutor),
    registerToolWindow({
      id: "coverage",
      title: "Coverage",
      icon: "toolwindow-coverage",
      anchor: "right",
      stripe: "onUse",
      order: 30,
      component: CoverageView,
      headerContent: CoverageTabs,
      headerActions: CoverageHeaderActions,
    }),
    registerEditorContribution({ id: "coverage.gutter", order: 65, extensions: coverageGutter }),
    syncCoverageViews(),
    registerActions([
      {
        id: "run.coverage",
        title: "Run with Coverage",
        description: "Run the selected configuration with coverage",
        category: "Run",
        icon: "run-coverage",
        when: "projectOpen",
        keywords: ["coverage", "code coverage"],
        run: () => executeAction("run.withExecutor", { executor: "coverage" }).then(() => undefined),
      },
      {
        id: "run.coverageContext",
        title: "Run Context Configuration with Coverage",
        description: "Run the test or program in the active file with coverage",
        category: "Run",
        icon: "run-coverage",
        when: "projectOpen",
        keywords: ["coverage"],
        run: ({ arg }) => executeAction("run.withExecutor", { executor: "coverage", context: arg ?? true }).then(() => undefined),
      },
      {
        id: "coverage.hide",
        title: "Hide Coverage",
        description: "Remove coverage highlighting from editors and the project view",
        category: "Run",
        icon: "close",
        when: "coverageVisible",
        run: () => setCoverageVisible(false),
      },
      {
        id: "coverage.show",
        title: "Show Coverage",
        description: "Show the selected coverage suite in editors and the project view",
        category: "Run",
        icon: "eye",
        when: "coverageSuites && !coverageVisible",
        run: () => {
          setCoverageVisible(true);
          toolWindowService().show("coverage");
        },
      },
    ]),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) resetCoverage();
    }),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    if (useCoverage.getState().suites.length) resetCoverage();
  };
}
