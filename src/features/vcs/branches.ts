/** Branches popup model: grouping, ordering and filtering (pure). */
import type { Branch } from "@/bindings";
import { tx } from "@/platform/i18n";
import { fuzzyMatch } from "@/ui/match";

export interface PopupAction {
  id: string;
  label: string;
  icon?: string;
  /** Action argument passed to `executeAction`. */
  arg?: unknown;
}

export type BranchGroup = "recent" | "local" | "remote";

export type BranchRow =
  | { type: "section"; key: string; label: string }
  | { type: "action"; key: string; action: PopupAction; matches: number[] | null }
  | {
      type: "branch";
      key: string;
      branch: Branch;
      group: BranchGroup;
      matches: number[] | null;
      favorite: boolean;
    }
  | { type: "tag"; key: string; tag: string; matches: number[] | null };

/** Current branch first, then favorites, then the rest; by name within each. */
function byRank(favorites: readonly string[] | null) {
  const rank = (b: Branch) => (b.current ? 0 : isFavoriteBranch(b, favorites) ? 1 : 2);
  return (a: Branch, b: Branch) => rank(a) - rank(b) || a.name.localeCompare(b.name);
}

export function sortLocal(branches: readonly Branch[], favorites: readonly string[] | null = null): Branch[] {
  return branches.filter((b) => !b.remote).sort(byRank(favorites));
}

export function sortRemote(branches: readonly Branch[], favorites: readonly string[] | null = null): Branch[] {
  return branches.filter((b) => b.remote && !b.name.endsWith("/HEAD")).sort(byRank(favorites));
}

/** `origin/feature/x` → `feature/x`. */
export function shortRemoteName(name: string): string {
  const i = name.indexOf("/");
  return i < 0 ? name : name.slice(i + 1);
}

export const MAX_RECENT = 5;

/**
 * Rows for the Branches popup. Without a query: actions, Recent (recently
 * checked-out local branches other than the current one), Local, Remote, Tags.
 * With a query: matching actions, branches and tags; the Recent group is dropped
 * so each branch appears once. Favorites (★) come right after the current branch.
 */
export function buildBranchRows(
  branches: readonly Branch[],
  recent: readonly string[],
  query: string,
  actions: readonly PopupAction[],
  favorites: readonly string[] | null = null,
  tags: readonly string[] = [],
): BranchRow[] {
  const rows: BranchRow[] = [];
  const q = query.trim();
  const match = (text: string): number[] | null | false => {
    if (!q) return null;
    return fuzzyMatch(text, q) ?? false;
  };

  for (const a of actions) {
    const m = match(tx(a.label));
    if (m === false) continue;
    rows.push({ type: "action", key: `action:${a.id}`, action: a, matches: m });
  }

  const local = sortLocal(branches, favorites);
  const pushGroup = (group: BranchGroup, label: string, list: readonly Branch[]) => {
    const items: BranchRow[] = [];
    for (const b of list) {
      const m = match(b.name);
      if (m === false) continue;
      items.push({
        type: "branch",
        key: `${group}:${b.name}`,
        branch: b,
        group,
        matches: m,
        favorite: isFavoriteBranch(b, favorites),
      });
    }
    if (!items.length) return;
    rows.push({ type: "section", key: `section:${group}`, label }, ...items);
  };

  if (!q) {
    const byName = new Map(local.map((b) => [b.name, b]));
    const rec = recent
      .map((n) => byName.get(n))
      .filter((b): b is Branch => !!b && !b.current)
      .slice(0, MAX_RECENT);
    pushGroup("recent", "Recent", rec);
  }
  pushGroup("local", "Local", local);
  pushGroup("remote", "Remote", sortRemote(branches, favorites));
  const tagRows: BranchRow[] = [];
  for (const t of [...tags].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const m = match(t);
    if (m !== false) tagRows.push({ type: "tag", key: `tag:${t}`, tag: t, matches: m });
  }
  if (tagRows.length) rows.push({ type: "section", key: "section:tags", label: "Tags" }, ...tagRows);
  return rows;
}

/** Moves `name` to the front of a recent-branches list. */
export function pushRecent(list: readonly string[], name: string, max = 20): string[] {
  return [name, ...list.filter((n) => n !== name)].slice(0, max);
}

const DEFAULT_FAVORITES = ["main", "master"];

/** Favorite branches (★): the user's list, or `main` / `master` (local and remote) until they edit it. */
export function isFavoriteBranch(b: Pick<Branch, "name" | "remote">, stored: readonly string[] | null): boolean {
  if (stored) return stored.includes(b.name);
  return DEFAULT_FAVORITES.includes(b.remote ? shortRemoteName(b.name) : b.name);
}

export interface BranchTreeNode {
  key: string;
  label: string;
  kind: "head" | "group" | "remote" | "folder" | "branch";
  /** Branch name for `branch` / `head` (`HEAD`). */
  ref: string | null;
  branch?: Branch;
  favorite?: boolean;
  children?: BranchTreeNode[];
}

/**
 * Git Log Branches pane: HEAD, Local and Remote › <remote>. Names with `/` are
 * grouped into folders (`feat/x` → feat › x); at each level the current branch and
 * favorites come first, then folders, then the other branches.
 */
export function buildBranchTree(branches: readonly Branch[], favorites: readonly string[] | null): BranchTreeNode[] {
  const level = (list: { b: Branch; rest: string }[], keyPrefix: string): BranchTreeNode[] => {
    const folders = new Map<string, { b: Branch; rest: string }[]>();
    const leaves: BranchTreeNode[] = [];
    for (const item of list) {
      const i = item.rest.indexOf("/");
      if (i > 0 && i < item.rest.length - 1) {
        const seg = item.rest.slice(0, i);
        folders.set(seg, [...(folders.get(seg) ?? []), { b: item.b, rest: item.rest.slice(i + 1) }]);
      } else {
        leaves.push({
          key: `b:${item.b.name}`,
          label: item.rest,
          kind: "branch",
          ref: item.b.name,
          branch: item.b,
          favorite: isFavoriteBranch(item.b, favorites),
        });
      }
    }
    const byName = (a: BranchTreeNode, b: BranchTreeNode) => a.label.localeCompare(b.label);
    const folderNodes = [...folders]
      .map(([seg, items]): BranchTreeNode => {
        const key = `${keyPrefix}/${seg}`;
        return { key, label: seg, kind: "folder", ref: null, children: level(items, key) };
      })
      .sort(byName);
    // IDEA: current branch, favorites, folders, the rest.
    const rank = (n: BranchTreeNode) => (n.branch?.current ? 0 : n.favorite ? 1 : 2);
    const top = leaves.filter((n) => rank(n) < 2).sort((a, b) => rank(a) - rank(b) || byName(a, b));
    return [...top, ...folderNodes, ...leaves.filter((n) => rank(n) === 2).sort(byName)];
  };
  const local = branches.filter((b) => !b.remote);
  const byRemote = new Map<string, Branch[]>();
  for (const b of branches) {
    if (!b.remote || b.name.endsWith("/HEAD")) continue;
    const i = b.name.indexOf("/");
    const r = i > 0 ? b.name.slice(0, i) : b.name;
    byRemote.set(r, [...(byRemote.get(r) ?? []), b]);
  }
  const out: BranchTreeNode[] = [{ key: "head", label: "HEAD (Current Branch)", kind: "head", ref: "HEAD" }];
  if (local.length)
    out.push({
      key: "g:local",
      label: "Local",
      kind: "group",
      ref: null,
      children: level(
        local.map((b) => ({ b, rest: b.name })),
        "f:local",
      ),
    });
  if (byRemote.size)
    out.push({
      key: "g:remote",
      label: "Remote",
      kind: "group",
      ref: null,
      children: [...byRemote].map(([r, list]) => ({
        key: `r:${r}`,
        label: r,
        kind: "remote",
        ref: null,
        children: level(
          list.map((b) => ({ b, rest: b.name.slice(r.length + 1) })),
          `f:r:${r}`,
        ),
      })),
    });
  return out;
}

/** Keys of the nodes on the way to branch `name` (to reveal it). */
export function branchFolderKeys(nodes: readonly BranchTreeNode[], name: string): string[] {
  const walk = (list: readonly BranchTreeNode[]): string[] | null => {
    for (const n of list) {
      if (n.kind === "branch" && n.ref === name) return [];
      const inner = n.children ? walk(n.children) : null;
      if (inner) return [n.key, ...inner];
    }
    return null;
  };
  return walk(nodes) ?? [];
}

/** Branches pane search: keeps branches whose full name contains `query` (case-insensitive) and their folders. */
export function filterBranchTree(nodes: readonly BranchTreeNode[], query: string): BranchTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...nodes];
  return nodes.flatMap((n): BranchTreeNode[] => {
    if (n.kind === "head") return [];
    if (n.kind === "branch") return n.ref?.toLowerCase().includes(q) ? [n] : [];
    const children = filterBranchTree(n.children ?? [], q);
    return children.length ? [{ ...n, children }] : [];
  });
}

/** Keys of every expandable node. */
export function branchGroupKeys(nodes: readonly BranchTreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children ? [n.key, ...branchGroupKeys(n.children)] : []));
}
