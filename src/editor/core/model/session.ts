/**
 * Editor session per project (IDEA's workspace.xml editor state): open file
 * tabs with pinned / preview flags and the active tab of every pane, the split
 * layout, the active pane and caret / scroll position per file. Serialised to
 * plain JSON (localStorage, keyed by project root) and rebuilt into a fresh
 * TabsState with new ids.
 */
import { initialTabsState, paneIds, type LayoutNode, type Pane, type Tab, type TabsState } from "./tabs";

export interface SessionTab {
  path: string;
  pinned?: boolean;
  preview?: boolean;
}

export type SessionLayout =
  | { kind: "pane"; tabs: SessionTab[]; active: number }
  | { kind: "split"; dir: "row" | "column"; children: SessionLayout[] };

export interface FileViewState {
  anchor: number;
  head: number;
  /** 0-based first visible line. */
  topLine?: number;
}

export interface EditorSession {
  version: 1;
  layout: SessionLayout;
  /** Index of the active pane in visual (depth-first) order. */
  activePane: number;
  files: Record<string, FileViewState>;
}

const STORAGE_PREFIX = "openidea.editorSession.v1:";

export function serializeSession(s: TabsState, files: Record<string, FileViewState>): EditorSession | null {
  const walk = (n: LayoutNode): SessionLayout | null => {
    if (n.kind === "pane") {
      const pane = s.panes[n.paneId];
      if (!pane) return null;
      const fileTabs = pane.tabs.filter((t) => t.input.kind === "file" && !!t.input.path);
      if (!fileTabs.length) return null;
      const active = Math.max(0, fileTabs.findIndex((t) => t.id === pane.active));
      return {
        kind: "pane",
        tabs: fileTabs.map((t) => ({
          path: t.input.path!,
          ...(t.pinned ? { pinned: true } : {}),
          ...(t.preview ? { preview: true } : {}),
        })),
        active,
      };
    }
    const children = n.children.map(walk).filter((c): c is SessionLayout => !!c);
    if (!children.length) return null;
    return children.length === 1 ? children[0]! : { kind: "split", dir: n.dir, children };
  };
  const layout = walk(s.layout);
  if (!layout) return null;
  // Active pane index among panes that survived serialisation.
  const kept = paneIds(s).filter((id) => s.panes[id]?.tabs.some((t) => t.input.kind === "file" && t.input.path));
  const activePane = Math.max(0, kept.indexOf(s.activePane));
  const paths = new Set<string>();
  const collect = (l: SessionLayout) => (l.kind === "pane" ? l.tabs.forEach((t) => paths.add(t.path)) : l.children.forEach(collect));
  collect(layout);
  const keptFiles: Record<string, FileViewState> = {};
  for (const p of paths) if (files[p]) keptFiles[p] = files[p]!;
  return { version: 1, layout, activePane, files: keptFiles };
}

/**
 * Windows paths saved before the backend sent `/`-separated paths: `C:\a\b`
 * and `\\?\C:\a\b` become `C:/a/b`. Other paths are returned as is.
 */
export function slashPath(p: string): string {
  return /^(\\\\\?\\)?[A-Za-z]:\\/.test(p) ? p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/") : p;
}

function isSessionTab(v: unknown): v is SessionTab {
  return !!v && typeof v === "object" && typeof (v as SessionTab).path === "string" && !!(v as SessionTab).path;
}

/** Validates untrusted JSON; returns null when unusable. */
export function parseSession(raw: unknown): EditorSession | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<EditorSession>;
  if (r.version !== 1) return null;
  const check = (l: unknown, depth: number): SessionLayout | null => {
    if (!l || typeof l !== "object" || depth > 16) return null;
    const n = l as SessionLayout;
    if (n.kind === "pane") {
      const tabs = Array.isArray(n.tabs) ? n.tabs.filter(isSessionTab).map((t) => ({ ...t, path: slashPath(t.path) })) : [];
      if (!tabs.length) return null;
      const active = typeof n.active === "number" && n.active >= 0 && n.active < tabs.length ? Math.floor(n.active) : 0;
      return { kind: "pane", tabs, active };
    }
    if (n.kind === "split" && (n.dir === "row" || n.dir === "column") && Array.isArray(n.children)) {
      const children = n.children.map((c) => check(c, depth + 1)).filter((c): c is SessionLayout => !!c);
      if (!children.length) return null;
      return children.length === 1 ? children[0]! : { kind: "split", dir: n.dir, children };
    }
    return null;
  };
  const layout = check(r.layout, 0);
  if (!layout) return null;
  const files: Record<string, FileViewState> = {};
  if (r.files && typeof r.files === "object") {
    for (const [path, v] of Object.entries(r.files)) {
      const f = v as Partial<FileViewState> | null;
      if (f && Number.isInteger(f.anchor) && Number.isInteger(f.head) && f.anchor! >= 0 && f.head! >= 0)
        files[slashPath(path)] = { anchor: f.anchor!, head: f.head!, ...(Number.isInteger(f.topLine) && f.topLine! >= 0 ? { topLine: f.topLine } : {}) };
    }
  }
  return { version: 1, layout, activePane: typeof r.activePane === "number" ? Math.max(0, Math.floor(r.activePane)) : 0, files };
}

let seq = 0;
const id = (p: string) => `${p}r${++seq}`;

/** Rebuilds a TabsState (fresh ids) from a session. */
export function restoreTabsState(session: EditorSession, fileKey: (path: string) => string): TabsState {
  const panes: Record<string, Pane> = {};
  const order: string[] = [];
  const build = (l: SessionLayout): LayoutNode => {
    if (l.kind === "pane") {
      const paneId = id("pane");
      const seen = new Set<string>();
      const tabs: Tab[] = [];
      let preview = false;
      for (const t of l.tabs) {
        if (seen.has(t.path)) continue;
        seen.add(t.path);
        // At most one preview tab per pane; pinned tabs first.
        const isPreview: boolean = !!t.preview && !t.pinned && !preview;
        preview ||= isPreview;
        tabs.push({ id: id("tab"), input: { kind: "file", key: fileKey(t.path), path: t.path }, pinned: !!t.pinned, preview: isPreview });
      }
      tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      const activePath = l.tabs[l.active]?.path;
      const active = tabs.find((t) => t.input.path === activePath) ?? tabs[0]!;
      panes[paneId] = { id: paneId, tabs, active: active.id, mru: [active.id, ...tabs.filter((t) => t !== active).map((t) => t.id)] };
      order.push(paneId);
      return { kind: "pane", paneId };
    }
    return { kind: "split", id: id("split"), dir: l.dir, children: l.children.map(build) };
  };
  const layout = build(session.layout);
  if (!order.length) return initialTabsState();
  return { layout, panes, activePane: order[Math.min(session.activePane, order.length - 1)]!, closed: [] };
}

export function loadSession(root: string): EditorSession | null {
  try {
    // Sessions saved under the backslash spelling of a Windows root are picked up too.
    const raw = localStorage.getItem(STORAGE_PREFIX + root) ?? legacyWindowsSession(root);
    return raw ? parseSession(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function legacyWindowsSession(root: string): string | null {
  if (!/^[A-Za-z]:\//.test(root)) return null;
  const native = root.replace(/\//g, "\\");
  return localStorage.getItem(STORAGE_PREFIX + native) ?? localStorage.getItem(STORAGE_PREFIX + "\\\\?\\" + native);
}

export function storeSession(root: string, session: EditorSession | null) {
  try {
    if (session) localStorage.setItem(STORAGE_PREFIX + root, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_PREFIX + root);
  } catch {
    /* storage unavailable */
  }
}
