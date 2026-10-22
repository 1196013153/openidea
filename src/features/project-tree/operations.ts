/**
 * File operations behind the project view's actions: new / rename / delete,
 * internal copy-cut-paste, drag & drop moves and OS file imports.
 */
import { createElement, Fragment } from "react";
import { askUsagesDetected, fileUsages, viewUsages } from "@/editor/refactor";
import { executeAction, getAction } from "@/platform/actions";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { confirmDialog } from "./ConfirmDialog";
import { runFileRefactoring } from "./fileRefactor";
import { openFileRefactorDialog, rememberedOptions } from "./FileRefactorDialogs";
import { projectFs } from "./fs";
import type { ProjectNode } from "./model";
import {
  isInside,
  isSameOrInside,
  joinPath,
  nameOf,
  packageSegments,
  parentOf,
  relativeTo,
  uniqueName,
  validateName,
  type PackageKind,
} from "./paths";
import {
  currentModel,
  type Editing,
  loadDir,
  revealPath,
  setClipboard,
  setExpanded,
  startEditing,
  useProjectTree,
} from "./store";

const get = () => useProjectTree.getState();

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isWindows = /Win/i.test(ua);
/** macOS and Windows file systems are case-insensitive by default. */
const caseInsensitive = /Mac|Win/i.test(ua);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fail(title: string, e: unknown) {
  notifications().notify({ level: "error", title, body: errorMessage(e) });
}

// ---------------------------------------------------------------------------
// Selection helpers

/** Selected nodes in tree order (placeholders excluded). */
export function selectedNodes(): ProjectNode[] {
  const { selected } = get();
  const model = currentModel();
  const out: ProjectNode[] = [];
  for (const key of selected) {
    const n = model.byKey.get(key);
    if (n && !n.placeholder) out.push(n);
  }
  return out;
}

export function leadNode(): ProjectNode | null {
  const { lead } = get();
  const model = currentModel();
  const n = lead ? model.byKey.get(lead) : undefined;
  if (n && !n.placeholder) return n;
  return selectedNodes()[0] ?? null;
}

/** Selected paths without entries nested in other selected folders. */
export function topLevelPaths(nodes: ProjectNode[] = selectedNodes()): string[] {
  const paths = nodes.map((n) => n.path);
  return paths.filter((p) => !paths.some((q) => q !== p && isInside(p, q)));
}

/** Folder that receives new / pasted items: the selected folder or the selected file's parent. */
export function targetFolder(node: ProjectNode | null = leadNode()): string | null {
  const { root } = get();
  if (!root) return null;
  if (!node) return root;
  return node.dir ? node.path : parentOf(node.path);
}

function siblingsOf(dir: string): string[] {
  return (get().listings.get(dir) ?? []).map((e) => e.name);
}

function expandFolder(path: string) {
  const model = currentModel();
  const key = model.keyOfPath.get(path) ?? path;
  const { expanded } = get();
  if (expanded.has(key) && expanded.has(path)) return;
  setExpanded(new Set(expanded).add(key).add(path));
}

// ---------------------------------------------------------------------------
// Open

export async function openFile(path: string, opts: { preview?: boolean; focus?: boolean } = {}) {
  const editor = maybeEditorService();
  if (!editor) {
    notifications().notify({ level: "warning", title: "No editor available", body: path, key: "project.noEditor" });
    return;
  }
  try {
    await editor.openFile(path, { preview: opts.preview, focus: opts.focus ?? true });
  } catch (e) {
    fail(`Cannot open ${nameOf(path)}`, e);
  }
}

export function openSelection() {
  for (const n of selectedNodes()) if (!n.dir) void openFile(n.path);
}

// ---------------------------------------------------------------------------
// New / rename

export async function beginNew(nodeKind: "file" | "dir", parent = targetFolder(), pkg?: PackageKind) {
  if (!parent) return;
  expandFolder(parent);
  await loadDir(parent);
  startEditing(pkg ? { kind: "new", parent, nodeKind: "dir", pkg } : { kind: "new", parent, nodeKind });
}

/** New › Package / Python Package: a dotted name creates nested folders. */
export function beginNewPackage(kind: PackageKind, parent = targetFolder()) {
  return beginNew("dir", parent, kind);
}

/** Folder path (below the parent) the inline editor's text creates. */
function newRelPath(editing: Extract<Editing, { kind: "new" }>, name: string): string | null {
  if (!editing.pkg) return name;
  return packageSegments(name, editing.pkg).segments?.join("/") ?? null;
}

export function beginRename(node: ProjectNode | null = leadNode()) {
  if (!node || node.root || node.placeholder) return;
  startEditing({ kind: "rename", key: node.key, path: node.path });
}

/** Rename… (⇧F6): IDEA's Rename dialog, updating references. */
export async function openRenameDialog(node: ProjectNode | null = leadNode()) {
  if (!node || node.root || node.placeholder) return;
  const parent = parentOf(node.path);
  await loadDir(parent);
  openFileRefactorDialog({
    kind: "rename",
    path: node.path,
    dir: node.dir,
    siblings: siblingsOf(parent),
    onDone: (moves) => void afterMove(moves),
  });
}

/** Move… (F6): IDEA's Move dialog for the selection, defaulting to `target` or the current folder. */
export function openMoveDialog(nodes: ProjectNode[] = selectedNodes(), target?: string) {
  const movable = nodes.filter((n) => !n.root && !n.placeholder);
  const paths = topLevelPaths(movable);
  openMoveDialogFor(paths, target, paths.length === 1 && movable.some((n) => n.path === paths[0] && n.dir));
}

function openMoveDialogFor(paths: string[], target?: string, dir?: boolean) {
  if (!paths.length) return;
  openFileRefactorDialog({
    kind: "move",
    paths,
    dir,
    target: target ?? parentOf(paths[0]!),
    onDone: (moves) => {
      void afterMove(moves);
      if (rememberedOptions("move").openInEditor)
        for (const m of moves) if (!get().listings.has(m.to)) void openFile(m.to, { focus: false });
    },
  });
}

/** Refreshes the folders a move touched and selects the moved items. */
async function afterMove(moves: { from: string; to: string }[]) {
  const dirs = new Set(moves.flatMap((m) => [parentOf(m.from), parentOf(m.to)]));
  await Promise.all([...dirs].map((d) => loadDir(d, true)));
  const first = moves[0];
  if (first) {
    expandFolder(parentOf(first.to));
    revealPath(first.to, true);
  }
}

export function cancelEditing() {
  startEditing(null);
}

/** Validates the inline editor's text against the target folder. */
export function checkEditingName(name: string) {
  const { editing } = get();
  if (!editing) return { error: null };
  if (editing.kind === "new" && editing.pkg) {
    const { segments, error } = packageSegments(name, editing.pkg);
    if (!segments) return { error };
    return validateName(segments.join("/"), {
      siblings: siblingsOf(editing.parent),
      allowNested: true,
      caseInsensitive,
      windows: isWindows,
    });
  }
  if (editing.kind === "new")
    return validateName(name, {
      siblings: siblingsOf(editing.parent),
      allowNested: true,
      caseInsensitive,
      windows: isWindows,
    });
  return validateName(name, {
    siblings: siblingsOf(parentOf(editing.path)),
    current: nameOf(editing.path),
    caseInsensitive,
    windows: isWindows,
  });
}

/** Commits the inline editor. Resolves false when the name was rejected (editor stays open). */
export async function commitEditing(name: string): Promise<boolean> {
  const { editing, root } = get();
  if (!editing || !root) return true;
  const check = checkEditingName(name);
  if (check.error) return false;
  const fs = projectFs(root);
  if (editing.kind === "new") {
    const path = joinPath(editing.parent, newRelPath(editing, name) ?? name);
    startEditing(null);
    try {
      if (editing.nodeKind === "file") await fs.createFile(path);
      else await fs.createDir(path);
      // Every folder of a Python package gets an `__init__.py`, as in PyCharm.
      if (editing.pkg === "python")
        for (let dir = path; isInside(dir, editing.parent) && dir !== editing.parent; dir = parentOf(dir))
          // An existing intermediate package keeps its own `__init__.py`.
          await fs.createFile(joinPath(dir, "__init__.py")).catch(() => {});
    } catch (e) {
      fail(editing.nodeKind === "file" ? "Cannot create file" : "Cannot create folder", e);
      return true;
    }
    await refreshAfterCreate(editing.parent, path);
    revealPath(path, true);
    if (editing.nodeKind === "file") void openFile(path, { focus: true });
    return true;
  }
  const to = joinPath(parentOf(editing.path), name);
  startEditing(null);
  if (to === editing.path) return true;
  const status = await runFileRefactoring([{ from: editing.path, to }], rememberedOptions("rename"), "Rename");
  if (status !== "done") return true;
  await loadDir(parentOf(to), true);
  revealPath(to, true);
  return true;
}

/** Reloads the folders a (possibly nested `a/b/c`) creation touched. */
async function refreshAfterCreate(parent: string, path: string) {
  const dirs = [parent];
  for (let p = parentOf(path); isInside(p, parent); p = parentOf(p)) dirs.push(p);
  for (const d of dirs) await loadDir(d, true);
}

// ---------------------------------------------------------------------------
// Delete

function describe(paths: string[]): string {
  return paths.length === 1 ? `'${nameOf(paths[0]!)}'` : `${paths.length} items`;
}

/** Visible rows in display order (roots, then children of expanded folders). */
function visibleNodes(): ProjectNode[] {
  const model = currentModel();
  const { expanded } = get();
  const out: ProjectNode[] = [];
  const walk = (list: readonly ProjectNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.dir && expanded.has(n.key)) walk(model.children.get(n.key) ?? []);
    }
  };
  walk(model.roots);
  return out;
}

/** IDEA keeps a selection after Delete: the next surviving row, else the previous one. */
export function selectionAfterDelete(rows: readonly ProjectNode[], deleted: readonly string[]): string | null {
  const gone = (n: ProjectNode) => n.placeholder || deleted.some((d) => isSameOrInside(n.path, d));
  let last = -1;
  rows.forEach((n, i) => {
    if (deleted.includes(n.path)) last = i;
  });
  if (last < 0) return null;
  for (let i = last + 1; i < rows.length; i++) if (!gone(rows[i]!)) return rows[i]!.path;
  for (let i = last - 1; i >= 0; i--) if (!gone(rows[i]!)) return rows[i]!.path;
  return null;
}

/** Safe delete searches at most this many files, for at most this long. */
const SAFE_DELETE_MAX_FILES = 20;
const SAFE_DELETE_TIMEOUT_MS = 15_000;

/**
 * IDEA's safe delete for files: usages of their top-level symbols from other
 * files (where the language server can tell) → "Usages Detected". True to go
 * on deleting; without usage support the plain confirmation stands.
 */
export async function safeToDelete(files: string[]): Promise<boolean> {
  if (files.length > SAFE_DELETE_MAX_FILES) return true;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SAFE_DELETE_TIMEOUT_MS);
  let result;
  try {
    result = await fileUsages(files, abort.signal);
  } catch {
    notifications().notify({ level: "warning", title: "Usage search did not finish; nothing was deleted", key: "project.safeDelete" });
    return false;
  } finally {
    clearTimeout(timer);
  }
  if (result.status !== "ok" || !result.usages.length) return true;
  const name = files.length === 1 ? nameOf(files[0]!) : `${files.length} files`;
  const subject = files.length === 1 ? `File '${name}'` : `The ${name}`;
  const answer = await askUsagesDetected(subject, result.usages, files.length > 1);
  if (answer === "view") viewUsages(name, result.usages);
  return answer === "delete";
}

/** Find Usages (⌥F7) on a file: usages of its top-level symbols from other files. */
export async function findFileUsages(path: string) {
  const name = nameOf(path);
  let result;
  try {
    result = await fileUsages([path]);
  } catch (e) {
    fail(`Cannot find usages of '${name}'`, e);
    return;
  }
  if (result.status !== "ok")
    notifications().notify({ level: "info", title: `Cannot find usages of '${name}'`, body: result.reason, group: "search" });
  else if (!result.usages.length)
    notifications().notify({ level: "info", title: `No usages of '${name}' found`, group: "search" });
  else viewUsages(name, result.usages);
}

/** Reload from Disk: re-reads the selected folders (and the folders of selected files) and their open documents. */
export async function reloadFromDisk(nodes: ProjectNode[] = selectedNodes()) {
  const targets = nodes.filter((n) => !n.placeholder);
  if (!targets.length) return;
  const dirs = new Set(targets.map((n) => (n.dir ? n.path : parentOf(n.path))));
  const loaded = [...get().listings.keys()].filter((p) => [...dirs].some((d) => isSameOrInside(p, d)));
  await Promise.all(loaded.map((p) => loadDir(p, true)));
  const files = targets.filter((n) => !n.dir).map((n) => n.path);
  if (files.length) delegate("file.reloadFromDisk", files);
}

export async function deleteSelection(nodes: ProjectNode[] = selectedNodes()) {
  const { root } = get();
  const paths = topLevelPaths(nodes.filter((n) => !n.root));
  if (!root || !paths.length) return;
  // Invoked from the tree (or its context menu): give the tree its focus back afterwards.
  const refocus = typeof document !== "undefined" && !!document.activeElement?.closest('[role="tree"], [role="menu"]');
  const folders = nodes.filter((n) => n.dir && paths.includes(n.path)).length;
  const ok = await confirmDialog({
    title: "Delete",
    okLabel: "Delete",
    message: createElement(
      Fragment,
      null,
      `Delete ${describe(paths)}${folders ? (paths.length === 1 ? " and its contents" : " (including folder contents)") : ""}?`,
      createElement("br"),
      "Items are moved to the Trash.",
    ),
  });
  if (!ok) return;
  const files = nodes.filter((n) => !n.dir && paths.includes(n.path)).map((n) => n.path);
  if (files.length && !(await safeToDelete(files))) return;
  const next = selectionAfterDelete(visibleNodes(), paths);
  const fs = projectFs(root);
  const parents = new Set<string>();
  const errors: string[] = [];
  for (const p of paths) {
    try {
      await fs.delete(p);
      parents.add(parentOf(p));
    } catch (e) {
      errors.push(`${nameOf(p)}: ${errorMessage(e)}`);
    }
  }
  if (errors.length)
    notifications().notify({ level: "error", title: "Some items could not be deleted", body: errors.join("\n") });
  await Promise.all([...parents].map((d) => loadDir(d, true)));
  if (next) revealPath(next, refocus);
}

// ---------------------------------------------------------------------------
// Clipboard / move / copy

export function copySelection(cut: boolean) {
  const paths = topLevelPaths(selectedNodes().filter((n) => !n.root));
  if (paths.length) setClipboard({ paths, cut });
}

export function canPaste(): boolean {
  return !!get().clipboard?.paths.length;
}

export async function paste(target = targetFolder()) {
  const { clipboard } = get();
  if (!clipboard || !target) return;
  const done = await transfer(clipboard.paths, target, clipboard.cut ? "move" : "copy");
  if (clipboard.cut && done) setClipboard(null);
}

/**
 * Moves or copies `paths` into `target`. Copies get a non-conflicting name
 * (`Foo copy.kt`); moves refuse to overwrite. Returns whether anything changed.
 */
export async function transfer(paths: string[], target: string, mode: "move" | "copy"): Promise<boolean> {
  if (mode === "move") return moveInto(paths, target);
  const { root } = get();
  if (!root) return false;
  const fs = projectFs(root);
  await loadDir(target);
  const taken = new Set(siblingsOf(target).map((n) => (caseInsensitive ? n.toLowerCase() : n)));
  const isTaken = (n: string) => taken.has(caseInsensitive ? n.toLowerCase() : n);
  const touched = new Set<string>([target]);
  const errors: string[] = [];
  let first: string | null = null;
  for (const src of paths) {
    const name = nameOf(src);
    if (isSameOrInside(target, src) && target !== parentOf(src) && src !== target) {
      errors.push(`${name}: cannot copy a folder into itself`);
      continue;
    }
    const srcIsDir = get().listings.has(src) || currentModel().byKey.get(src)?.dir === true;
    const finalName = uniqueName(name, isTaken, srcIsDir);
    const to = joinPath(target, finalName);
    try {
      await fs.copy(src, to);
      taken.add(caseInsensitive ? finalName.toLowerCase() : finalName);
      first ??= to;
    } catch (e) {
      errors.push(`${name}: ${errorMessage(e)}`);
    }
  }
  if (errors.length)
    notifications().notify({ level: "error", title: "Some items could not be copied", body: errors.join("\n") });
  await Promise.all([...touched].map((d) => loadDir(d, true)));
  if (first) {
    expandFolder(target);
    revealPath(first, false);
  }
  return first !== null;
}

/**
 * Moves `paths` into `target` as one Move refactoring (references updated with
 * the options last used in the Move dialog). Refuses to overwrite.
 */
async function moveInto(paths: string[], target: string): Promise<boolean> {
  await loadDir(target);
  const taken = new Set(siblingsOf(target).map((n) => (caseInsensitive ? n.toLowerCase() : n)));
  const errors: string[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const src of paths) {
    const name = nameOf(src);
    if (parentOf(src) === target) continue;
    if (isSameOrInside(target, src)) errors.push(`${name}: cannot move a folder into itself`);
    else if (taken.has(caseInsensitive ? name.toLowerCase() : name))
      errors.push(`${name}: already exists in ${nameOf(target) || target}`);
    else moves.push({ from: src, to: joinPath(target, name) });
  }
  if (errors.length)
    notifications().notify({ level: "error", title: "Some items could not be moved", body: errors.join("\n") });
  if (!moves.length) return false;
  const status = await runFileRefactoring(moves, rememberedOptions("move"), "Move");
  if (status !== "done") return false;
  await afterMove(moves);
  revealPath(moves[0]!.to, false);
  return true;
}

/** Drag & drop inside the tree: the Move dialog (or a confirmed copy with ⌥). */
export async function dropPaths(paths: string[], target: string, copy: boolean) {
  const movable = topLevelPaths(
    paths.map((p) => currentModel().byKey.get(currentModel().keyOfPath.get(p) ?? p)).filter((n): n is ProjectNode => !!n),
  ).filter((p) => copy || parentOf(p) !== target);
  if (!movable.length) return;
  // IDEA opens the Move refactoring dialog for drops inside the project.
  if (!copy) {
    const node = movable.length === 1 ? currentModel().byKey.get(currentModel().keyOfPath.get(movable[0]!) ?? "") : undefined;
    return openMoveDialogFor(movable, target, node?.dir);
  }
  const { root } = get();
  const where = root && target === root ? (get().name ?? nameOf(target)) : relativeTo(root ?? "", target) || target;
  const ok = await confirmDialog({ title: "Copy", okLabel: "Copy", message: `Copy ${describe(movable)} to '${where}'?` });
  if (ok) await transfer(movable, target, "copy");
}

/** Files dropped from the OS: copied into `target` (never moved). */
export async function importExternal(paths: string[], target: string) {
  const { root } = get();
  if (!root || !paths.length) return;
  const inside = paths.filter((p) => isSameOrInside(p, root));
  const outside = paths.filter((p) => !isSameOrInside(p, root));
  if (inside.length) await dropPaths(inside, target, false);
  if (outside.length) await transfer(outside, target, "copy");
}

// ---------------------------------------------------------------------------
// Paths / external

export type PathKind = "absolute" | "relative" | "name";

export function pathsFor(kind: PathKind, nodes: ProjectNode[] = selectedNodes()): string[] {
  const { root } = get();
  return nodes.map((n) =>
    kind === "absolute" ? n.path : kind === "name" ? nameOf(n.path) : relativeTo(root ?? "", n.path) || ".",
  );
}

export async function copyPaths(kind: PathKind, nodes: ProjectNode[] = selectedNodes()) {
  const text = pathsFor(kind, nodes).join("\n");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    fail("Cannot access the clipboard", e);
  }
}

export async function revealInFinder(nodes: ProjectNode[] = selectedNodes()) {
  const paths = nodes.map((n) => n.path);
  if (!paths.length) return;
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(paths.length === 1 ? paths[0]! : paths);
  } catch (e) {
    fail("Cannot reveal in Finder", e);
  }
}

export function folderOf(node: ProjectNode | null = leadNode()): string | null {
  return targetFolder(node);
}

/** Runs another feature's action if it is registered; returns whether it exists. */
export function delegate(id: string, arg: unknown): boolean {
  if (!getAction(id)) return false;
  void executeAction(id, arg);
  return true;
}

/** Argument for VCS actions: one path or several. */
export function vcsArg(nodes: ProjectNode[] = selectedNodes()): string | string[] {
  const paths = nodes.map((n) => n.path);
  return paths.length === 1 ? paths[0]! : paths;
}
