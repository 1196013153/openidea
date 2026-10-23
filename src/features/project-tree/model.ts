/**
 * Pure project tree model: turns lazily loaded directory listings into tree
 * nodes (filtering, sorting, IDEA's "Compact Middle Packages") and plans the
 * incremental refresh for `fsChanged` events. No React, no IPC.
 */
import type { FileEntry } from "@/bindings";
import { isIgnoredName } from "@/platform/ignoredNames";
import { isSameOrInside, nameOf, parentOf, relativeTo } from "./paths";

export interface TreeOptions {
  /** Show ignored names (`files.ignoredNames`: `.git`, `.DS_Store`, …). Dotfiles are always shown. */
  showHidden: boolean;
  /** Show entries matched by .gitignore / exclude settings (dimmed). */
  showExcluded: boolean;
  /** Merge single-child folder chains (`com/acme/orders` → `com.acme.orders`). */
  compact: boolean;
  foldersFirst: boolean;
}

export const DEFAULT_TREE_OPTIONS: TreeOptions = {
  showHidden: false,
  showExcluded: true,
  compact: true,
  foldersFirst: true,
};

export interface ProjectNode {
  /** Tree key: the path of the first folder of a compacted chain, else `path`. */
  key: string;
  /** Effective path: the last folder of a chain (operations target it), or the file. */
  path: string;
  /** Folder paths merged into this node (just `[path]` when not compacted). */
  chain: string[];
  label: string;
  dir: boolean;
  root: boolean;
  entry: FileEntry | null;
  ignored: boolean;
  symlink: boolean;
  /** Placeholder row for the inline "new file / folder" editor. */
  placeholder?: "file" | "dir";
  /** Root of a contributed folder outside the project ("Scratches"): its icon. */
  icon?: string;
}

export interface TreeModel {
  roots: ProjectNode[];
  /** Loaded children per node key. */
  children: Map<string, ProjectNode[]>;
  byKey: Map<string, ProjectNode>;
  /** Any folder / file path present in the model → key of the node showing it. */
  keyOfPath: Map<string, string>;
}

export type Listings = ReadonlyMap<string, readonly FileEntry[]>;

export function isVisible(entry: FileEntry, opts: TreeOptions): boolean {
  // Ignored names are also excluded on the backend; only "Show Hidden" brings them back.
  if (isIgnoredName(entry.name)) return opts.showHidden;
  if (!opts.showExcluded && entry.ignored) return false;
  return true;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Symlinks report the target's metadata; folders have size 0 (the entry has no target kind). */
export const isDirEntry = (e: FileEntry) => e.kind === "dir" || (e.kind === "symlink" && e.size === 0);

export function sortEntries(entries: readonly FileEntry[], foldersFirst: boolean): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (foldersFirst) {
      const d = Number(isDirEntry(b)) - Number(isDirEntry(a));
      if (d) return d;
    }
    return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
}

/** Visible, sorted entries of a loaded folder. */
export function visibleEntries(listing: readonly FileEntry[], opts: TreeOptions): FileEntry[] {
  const filtered = listing.filter((e) => isVisible(e, opts));
  // The backend already sorts folders first (natural order); only re-sort when needed.
  return opts.foldersFirst ? filtered : sortEntries(filtered, false);
}

/** JVM-style source folders join compacted package chains with `.` instead of `/`. */
const PACKAGE_ROOT = /(^|\/)(java|kotlin|scala|groovy)(\/|$)/;

/** `src/main/kotlin`-style source roots end a chain: packages below them compact separately. */
const SOURCE_ROOT = /(^|\/)(main|test)\/(java|kotlin|scala|groovy)$/;

function chainSeparator(root: string, head: string): string {
  return PACKAGE_ROOT.test(relativeTo(root, parentOf(head))) ? "." : "/";
}

export interface Placeholder {
  /** Folder (effective path) receiving the new item. */
  parent: string;
  kind: "file" | "dir";
}

export const PLACEHOLDER_SUFFIX = "\u0000new";

export function buildModel(
  root: { path: string; name: string },
  listings: Listings,
  opts: TreeOptions,
  placeholder?: Placeholder | null,
): TreeModel {
  const children = new Map<string, ProjectNode[]>();
  const byKey = new Map<string, ProjectNode>();
  const keyOfPath = new Map<string, string>();

  const rootNode: ProjectNode = {
    key: root.path,
    path: root.path,
    chain: [root.path],
    label: root.name,
    dir: true,
    root: true,
    entry: null,
    ignored: false,
    symlink: false,
  };
  byKey.set(rootNode.key, rootNode);
  keyOfPath.set(root.path, rootNode.key);

  const makeNode = (entry: FileEntry): ProjectNode => {
    const dir = isDirEntry(entry);
    if (!dir) {
      return {
        key: entry.path,
        path: entry.path,
        chain: [entry.path],
        label: entry.name,
        dir: false,
        root: false,
        entry,
        ignored: entry.ignored,
        symlink: entry.kind === "symlink",
      };
    }
    const chain = [entry.path];
    const names = [entry.name];
    let end = entry;
    if (opts.compact && !(placeholder && placeholder.parent === entry.path)) {
      for (;;) {
        if (SOURCE_ROOT.test(relativeTo(root.path, end.path))) break;
        const listing = listings.get(end.path);
        if (!listing) break;
        const visible = visibleEntries(listing, opts);
        if (visible.length !== 1) break;
        const only = visible[0]!;
        if (!isDirEntry(only) || only.ignored !== entry.ignored) break;
        if (placeholder && placeholder.parent === only.path) break;
        end = only;
        chain.push(only.path);
        names.push(only.name);
      }
    }
    const label = names.length > 1 ? names.join(chainSeparator(root.path, entry.path)) : entry.name;
    return {
      key: entry.path,
      path: end.path,
      chain,
      label,
      dir: true,
      root: false,
      entry: end,
      ignored: entry.ignored,
      symlink: entry.kind === "symlink",
    };
  };

  const fill = (node: ProjectNode) => {
    const listing = listings.get(node.path);
    if (!listing) return;
    const kids = visibleEntries(listing, opts).map(makeNode);
    if (placeholder && placeholder.parent === node.path) {
      const ph: ProjectNode = {
        key: node.path + PLACEHOLDER_SUFFIX,
        path: node.path,
        chain: [],
        label: "",
        dir: placeholder.kind === "dir",
        root: false,
        entry: null,
        ignored: false,
        symlink: false,
        placeholder: placeholder.kind,
      };
      kids.unshift(ph);
    }
    children.set(node.key, kids);
    for (const kid of kids) {
      byKey.set(kid.key, kid);
      if (kid.placeholder) continue;
      for (const p of kid.chain) keyOfPath.set(p, kid.key);
      if (kid.dir) fill(kid);
    }
  };
  fill(rootNode);

  return { roots: [rootNode], children, byKey, keyOfPath };
}

/**
 * Adds contributed roots (folders outside the project, e.g. scratches) after
 * the project root. Each lists its folder like the project root does.
 */
export function withExtraRoots(
  model: TreeModel,
  extras: ReadonlyArray<{ path: string; label: string; icon: string }>,
  listings: Listings,
  opts: TreeOptions,
  placeholder?: Placeholder | null,
): TreeModel {
  if (!extras.length) return model;
  const out: TreeModel = {
    roots: [...model.roots],
    children: new Map(model.children),
    byKey: new Map(model.byKey),
    keyOfPath: new Map(model.keyOfPath),
  };
  for (const extra of extras) {
    if (out.byKey.has(extra.path)) continue;
    const sub = buildModel({ path: extra.path, name: extra.label }, listings, opts, placeholder);
    const rootNode = { ...sub.roots[0]!, icon: extra.icon };
    sub.byKey.set(rootNode.key, rootNode);
    out.roots.push(rootNode);
    for (const [k, v] of sub.children) out.children.set(k, v);
    for (const [k, v] of sub.byKey) out.byKey.set(k, v);
    for (const [k, v] of sub.keyOfPath) out.keyOfPath.set(k, v);
  }
  return out;
}

export interface VisibleInfo {
  /** Node keys currently rendered (ancestors expanded). */
  visible: Set<string>;
  /** Effective folder paths that are expanded but not loaded yet. */
  pending: string[];
}

/** Walks expanded nodes: which rows are visible and which folders still need loading. */
export function visibleInfo(model: TreeModel, expanded: ReadonlySet<string>): VisibleInfo {
  const visible = new Set<string>();
  const pending: string[] = [];
  const walk = (nodes: readonly ProjectNode[]) => {
    for (const n of nodes) {
      visible.add(n.key);
      if (!n.dir || !expanded.has(n.key)) continue;
      const kids = model.children.get(n.key);
      if (kids) walk(kids);
      else pending.push(n.path);
    }
  };
  walk(model.roots);
  return { visible, pending };
}

/** Resolves the key of the node showing `path`, falling back to its closest shown ancestor. */
export function nodeKeyFor(model: TreeModel, path: string): string | null {
  for (let p = path; ; p = parentOf(p)) {
    const k = model.keyOfPath.get(p);
    if (k) return k;
    if (p === "/" || !p) return null;
  }
}

// ---------------------------------------------------------------------------
// Refresh on fsChanged

export interface RefreshPlan {
  /** Loaded folders whose listing must be re-read. */
  reload: string[];
  /** Loaded folders that no longer exist (drop with their loaded descendants). */
  drop: string[];
}

export function planRefresh(
  event: { created: readonly string[]; modified: readonly string[]; removed: readonly string[] },
  loaded: ReadonlySet<string>,
): RefreshPlan {
  const reload = new Set<string>();
  const drop = new Set<string>();
  const loadedList = [...loaded];

  for (const p of event.removed) {
    for (const dir of loadedList) if (isSameOrInside(dir, p)) drop.add(dir);
    const parent = parentOf(p);
    if (loaded.has(parent)) reload.add(parent);
  }
  for (const p of [...event.created, ...event.modified]) {
    const parent = parentOf(p);
    if (loaded.has(parent)) reload.add(parent);
    // A folder recreated / renamed into place, or a watcher reporting the folder itself.
    if (loaded.has(p)) {
      reload.add(p);
      drop.delete(p);
    }
  }
  for (const d of drop) reload.delete(d);
  // A reloaded parent may report the folder as present again; keep its descendants then.
  return { reload: [...reload], drop: [...drop] };
}

const sameEntry = (a: FileEntry, b: FileEntry) =>
  a.name === b.name &&
  a.path === b.path &&
  a.kind === b.kind &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ignored === b.ignored &&
  a.hidden === b.hidden;

/**
 * Merges a re-read listing into the previous one, keeping unchanged entry
 * objects (stable identity → no re-render). Returns `prev` itself if nothing changed.
 */
export function mergeListing(prev: readonly FileEntry[] | undefined, next: readonly FileEntry[]): readonly FileEntry[] {
  if (!prev) return next;
  const old = new Map(prev.map((e) => [e.path, e]));
  let changed = prev.length !== next.length;
  const merged = next.map((e, i) => {
    const o = old.get(e.path);
    if (o && sameEntry(o, e)) {
      if (prev[i] !== o) changed = true;
      return o;
    }
    changed = true;
    return e;
  });
  return changed ? merged : prev;
}

/** Removes `dirs` and every loaded folder inside them. */
export function dropListings(listings: Map<string, readonly FileEntry[]>, dirs: readonly string[]) {
  if (!dirs.length) return;
  for (const key of [...listings.keys()]) if (dirs.some((d) => isSameOrInside(key, d))) listings.delete(key);
}

/** Label for a node path used in dialogs: the file name, or the compacted label. */
export function displayName(node: ProjectNode): string {
  return node.root ? node.label : nameOf(node.path);
}
