/** Actions of the project view (Find Action, keymap, other features via `executeAction`). */
import { registerActions, type Action } from "@/platform/actions";
import { maybeEditorService, toolWindowService } from "@/workbench/contributions";
import { OPTION_LABELS } from "./HeaderActions";
import { revealLabel } from "./contextMenu";
import type { ProjectNode } from "./model";
import {
  beginNew,
  beginRename,
  copyPaths,
  copySelection,
  delegate,
  deleteSelection,
  findFileUsages,
  folderOf,
  leadNode,
  openMoveDialog,
  openRenameDialog,
  openSelection,
  paste,
  reloadFromDisk,
  revealInFinder,
  selectedNodes,
  type PathKind,
} from "./operations";
import { nameOf, parentOf } from "./paths";
import { showNewPopup, treeHandle } from "./ProjectView";
import { lastFileRefactoring, undoFileRefactoring } from "./fileRefactor";
import { collapseAll, currentModel, expandAll, reloadAll, revealPath, setViewOption, useProjectTree } from "./store";

const FOCUS = "projectViewFocus";
const OPEN = "projectOpen";

/** Nodes for an action: paths passed as the argument, else the tree selection. */
function nodesFrom(arg: unknown): ProjectNode[] {
  const paths = typeof arg === "string" ? [arg] : Array.isArray(arg) ? arg.filter((p) => typeof p === "string") : null;
  if (!paths) return selectedNodes();
  const model = currentModel();
  return paths.map((p) => {
    const key = model.keyOfPath.get(p);
    const n = key ? model.byKey.get(key) : undefined;
    if (n && n.path === p) return n;
    const dir = useProjectTree.getState().listings.has(p);
    return {
      key: p,
      path: p,
      chain: [p],
      label: nameOf(p),
      dir,
      root: p === useProjectTree.getState().root,
      entry: null,
      ignored: false,
      excluded: false,
      symlink: false,
    };
  });
}

function folderFrom(arg: unknown): string | null {
  if (typeof arg === "string") return useProjectTree.getState().listings.has(arg) ? arg : parentOf(arg);
  return folderOf(leadNode());
}

function showProjectView(focus: boolean) {
  try {
    toolWindowService().show("project", focus);
  } catch {
    /* tool window service not available (tests) */
  }
}

/** Selects `path` (default: the active editor's file) in the project view. */
export function selectInProjectView(path?: string | null, focus = true) {
  const target = path ?? maybeEditorService()?.activePath() ?? null;
  if (!target) return false;
  showProjectView(focus);
  return revealPath(target, focus);
}

export function registerProjectActions(): () => void {
  const copyPath = (kind: PathKind, id: string, title: string): Action => ({
    id,
    title,
    category: "Project View",
    when: OPEN,
    keywords: ["path", "clipboard"],
    run: ({ arg }) => copyPaths(kind, nodesFrom(arg)),
  });

  const toggles: Action[] = OPTION_LABELS.map(([key, label]) => ({
    id: `project.option.${key}`,
    title: `Project View: ${label}`,
    category: "View",
    keywords: ["project", "tree", "toggle"],
    run: () => setViewOption(key, !useProjectTree.getState().options[key]),
  }));

  return registerActions([
    {
      id: "navigate.selectIn",
      title: "Select in Project View",
      category: "Navigate",
      icon: "locate",
      when: OPEN,
      keywords: ["locate", "reveal", "scroll from source"],
      run: ({ arg }) =>
        void selectInProjectView(
          typeof arg === "string" ? arg : ((arg as { path?: string } | undefined)?.path ?? null),
        ),
    },
    {
      id: "project.reveal",
      title: "Reveal in Project View",
      category: "Project View",
      hidden: true,
      when: OPEN,
      run: ({ arg }) => void selectInProjectView(typeof arg === "string" ? arg : null, false),
    },
    {
      id: "project.newFile",
      title: "New File",
      category: "File",
      icon: "file",
      when: OPEN,
      keywords: ["create"],
      run: ({ arg, ctx }) => {
        // ⌘N inside the project view opens the New popup (File, Directory, templates).
        if (arg === undefined && ctx[FOCUS] && showNewPopup()) return;
        // No focus request: the inline editor takes focus itself.
        showProjectView(false);
        return beginNew("file", folderFrom(arg));
      },
    },
    {
      // File › New (native menu, VS Code preset): same as New File at the selection.
      id: "file.new",
      title: "New…",
      category: "File",
      hidden: true,
      when: OPEN,
      run: ({ arg }) => {
        showProjectView(false);
        return beginNew("file", folderFrom(arg));
      },
    },
    {
      id: "project.newFolder",
      title: "New Directory",
      category: "File",
      icon: "folder",
      when: OPEN,
      keywords: ["create", "folder", "directory"],
      run: ({ arg }) => {
        // No focus request: the inline editor takes focus itself.
        showProjectView(false);
        return beginNew("dir", folderFrom(arg));
      },
    },
    {
      id: "project.open",
      title: "Jump to Source",
      category: "Project View",
      when: FOCUS,
      run: openSelection,
    },
    {
      id: "project.rename",
      title: "Rename File…",
      category: "Project View",
      icon: "edit",
      // Also from editor tabs and Find Action (the active file); ⇧F6 only in the project view.
      when: OPEN,
      keyWhen: FOCUS,
      keywords: ["refactor"],
      run: ({ arg, ctx }) => {
        if (arg !== undefined) return openRenameDialog(nodesFrom(arg)[0] ?? null);
        const active = ctx[FOCUS] ? null : (maybeEditorService()?.activePath() ?? null);
        return openRenameDialog(active ? (nodesFrom(active)[0] ?? null) : leadNode());
      },
    },
    {
      id: "project.renameInline",
      title: "Rename File Inline",
      category: "Project View",
      hidden: true,
      when: FOCUS,
      run: () => beginRename(),
    },
    {
      id: "project.move",
      title: "Move File…",
      category: "Project View",
      when: FOCUS,
      keywords: ["refactor", "package"],
      run: ({ arg }) => openMoveDialog(nodesFrom(arg)),
    },
    {
      id: "project.undoMove",
      title: "Undo Move / Rename",
      category: "Project View",
      when: OPEN,
      keywords: ["refactor", "undo"],
      description: "Reverts the last file move or rename and its reference updates",
      run: () => {
        if (lastFileRefactoring()) void undoFileRefactoring();
      },
    },
    {
      id: "project.delete",
      title: "Delete…",
      category: "Project View",
      icon: "trash",
      when: FOCUS,
      keywords: ["remove", "trash"],
      run: ({ arg }) => deleteSelection(nodesFrom(arg)),
    },
    { id: "project.copy", title: "Copy", category: "Project View", when: FOCUS, run: () => copySelection(false) },
    { id: "project.cut", title: "Cut", category: "Project View", when: FOCUS, run: () => copySelection(true) },
    { id: "project.paste", title: "Paste", category: "Project View", when: FOCUS, run: () => paste() },
    {
      id: "project.copyPath",
      title: "Copy Path",
      category: "Project View",
      when: OPEN,
      hidden: true,
      run: ({ arg }) => {
        const a = (arg ?? {}) as { kind?: PathKind; paths?: string[] };
        return copyPaths(a.kind ?? "absolute", nodesFrom(a.paths));
      },
    },
    copyPath("absolute", "project.copyAbsolutePath", "Copy Absolute Path"),
    copyPath("relative", "project.copyRelativePath", "Copy Path From Content Root"),
    copyPath("name", "project.copyFileName", "Copy File Name"),
    {
      id: "project.revealInFinder",
      title: `Reveal in ${revealLabel()}`,
      category: "Project View",
      icon: "external-link",
      when: OPEN,
      keywords: ["show in explorer", "open in finder"],
      run: ({ arg }) => revealInFinder(nodesFrom(arg)),
    },
    {
      id: "project.openInTerminal",
      title: "Open in Terminal",
      category: "Project View",
      icon: "terminal",
      when: OPEN,
      run: ({ arg }) => {
        const dir = folderFrom(arg);
        if (dir) delegate("terminal.openAt", dir);
      },
    },
    {
      id: "project.findInFolder",
      title: "Find in Folder…",
      category: "Project View",
      icon: "search",
      when: OPEN,
      run: ({ arg }) => {
        const dir = folderFrom(arg);
        if (dir) delegate("find.inPath", { directory: dir });
      },
    },
    {
      id: "project.showHistory",
      title: "Local History: Show History",
      category: "Project View",
      icon: "history",
      when: OPEN,
      run: ({ arg }) => {
        const node = nodesFrom(arg)[0];
        if (node) delegate("vcs.localHistory", node.path);
      },
    },
    {
      id: "project.findUsages",
      title: "Find Usages of File",
      category: "Project View",
      when: FOCUS,
      keywords: ["references", "imports"],
      run: ({ arg }) => {
        const node = nodesFrom(arg)[0];
        if (node && !node.dir) void findFileUsages(node.path);
      },
    },
    {
      id: "project.reformatCode",
      title: "Reformat File",
      category: "Project View",
      hidden: true,
      when: FOCUS,
      run: ({ arg }) => {
        const node = nodesFrom(arg)[0];
        if (node && !node.dir) delegate("code.reformatFile", { path: node.path });
      },
    },
    {
      id: "project.optimizeImports",
      title: "Optimize Imports in File",
      category: "Project View",
      hidden: true,
      when: FOCUS,
      run: ({ arg }) => {
        const node = nodesFrom(arg)[0];
        if (node && !node.dir) delegate("code.optimizeImportsFile", { path: node.path });
      },
    },
    {
      id: "project.compareWith",
      title: "Compare With…",
      category: "Project View",
      hidden: true,
      when: FOCUS,
      run: ({ arg }) => {
        const files = nodesFrom(arg).filter((n) => !n.dir);
        if (files.length === 2) delegate("diff.compareFiles", files.map((f) => f.path));
        else if (files[0]) delegate("diff.compareWith", files[0].path);
      },
    },
    {
      id: "project.reloadFromDisk",
      title: "Reload from Disk",
      category: "Project View",
      icon: "refresh",
      when: OPEN,
      keywords: ["synchronize", "refresh"],
      run: ({ arg }) => reloadFromDisk(nodesFrom(arg)),
    },
    {
      id: "project.expandAll",
      title: "Expand All",
      category: "Project View",
      icon: "expand-all",
      when: OPEN,
      run: () => {
        const lead = leadNode();
        return expandAll(lead?.dir && !lead.root ? lead.path : undefined);
      },
    },
    {
      id: "project.collapseAll",
      title: "Collapse All",
      category: "Project View",
      icon: "collapse-all",
      when: OPEN,
      run: () => {
        collapseAll();
        treeHandle.current?.focus();
      },
    },
    {
      id: "project.refresh",
      title: "Reload Project Tree from Disk",
      category: "File",
      icon: "refresh",
      when: OPEN,
      keywords: ["synchronize", "refresh"],
      run: reloadAll,
    },
    ...toggles,
  ]);
}
