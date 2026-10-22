/** Project view: the "project" tool window, its file operations and actions. */
import { onIdeEvent } from "@/platform/ipc";
import type { RootFolder } from "@/platform/languageSettings";
import { useProject } from "@/platform/project";
import { initProjectRoots, useProjectRoots } from "@/platform/projectRoots";
import { registerOverlay, registerToolWindow, useProjectViewRoots } from "@/workbench/contributions";
import { registerProjectActions } from "./actions";
import { ConfirmDialogHost } from "./ConfirmDialog";
import { FileRefactorDialogHost } from "./FileRefactorDialogs";
import { RefactoringPreviewHost } from "./RefactoringPreview";
import { ProjectHeaderActions, useProjectHeaderMenu } from "./HeaderActions";
import { loadHomeDir } from "./home";
import { ProjectView } from "./ProjectView";
import { applyFsChange, initProjectTree, reloadAll, useProjectTree } from "./store";

export function activate(): () => void {
  loadHomeDir();
  const sync = () => {
    const p = useProject.getState().project;
    const s = useProjectTree.getState();
    if ((p?.root ?? null) !== s.root) initProjectTree(p?.root ?? null, p?.name ?? "");
    else if (p && p.name !== s.name) useProjectTree.setState({ name: p.name });
  };
  sync();
  const unsubProject = useProject.subscribe((s, prev) => {
    if (s.project !== prev.project) sync();
  });
  // Excluded folders / exclude globs change which entries are `ignored`.
  const unsubExcludes = useProject.subscribe((s, prev) => {
    const ex = (x: typeof s.settings) =>
      JSON.stringify([x?.files?.exclude, x?.projectStructure?.excluded, x?.projectStructure?.unmarked]);
    if (s.settings !== prev.settings && prev.settings && ex(s.settings) !== ex(prev.settings)) void reloadAll();
  });
  // …and so do excluded roots detected from build files (`target`, `node_modules`, …).
  const disposeRoots = initProjectRoots();
  const detectedExcluded = (s: { root: string | null; detected: readonly RootFolder[] }) =>
    JSON.stringify([s.root, s.detected.filter((r) => r.kind === "excluded").map((r) => r.path)]);
  const unsubRoots = useProjectRoots.subscribe((s, prev) => {
    if (s.root && s.root === prev.root && detectedExcluded(s) !== detectedExcluded(prev)) void reloadAll();
  });

  // Contributed roots (Scratches) are part of the derived model: re-render.
  const unsubExtraRoots = useProjectViewRoots.subscribe(() =>
    useProjectTree.setState((s) => ({ listings: new Map(s.listings) })),
  );

  const disposers = [
    unsubProject,
    unsubExtraRoots,
    unsubExcludes,
    disposeRoots,
    unsubRoots,
    registerToolWindow({
      id: "project",
      title: "Project",
      icon: "toolwindow-project",
      anchor: "left",
      order: 0,
      component: ProjectView,
      headerActions: ProjectHeaderActions,
      headerMenu: useProjectHeaderMenu,
    }),
    registerOverlay({ id: "project.confirm", component: ConfirmDialogHost }),
    registerOverlay({ id: "project.fileRefactor", component: FileRefactorDialogHost }),
    registerOverlay({ id: "project.refactoringPreview", component: RefactoringPreviewHost }),
    registerProjectActions(),
    onIdeEvent("fsChanged", (e) => void applyFsChange(e)),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    initProjectTree(null);
  };
}
