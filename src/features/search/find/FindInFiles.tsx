import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { openEditorPaths, useEditorRegistry } from "@/editor/api";
import { call, commands, type SearchScope } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  Button,
  Checkbox,
  Dialog,
  IconButton,
  List,
  Menu,
  SearchField,
  Select,
  Spinner,
  Tabs,
  listNavigate,
  type MenuItem,
} from "@/ui";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { basename, dirname, openLocation } from "../common/open";
import { CodePreview, MatchText, ReplaceDiffPreview } from "./parts";
import { clearPreviewCache } from "./preview";
import {
  NO_MARKS,
  confirmText,
  countUsages,
  groupState,
  loadReplacePreview,
  markDone,
  nextPending,
  pendingUsages,
  replacePreviewLines,
  replaceTargets,
  startReplace,
  summaryText,
  type PreviewLine,
  type ReplaceMarks,
  type ReplaceProgress,
  type ReplaceRun,
  type Usage,
} from "./replaceFlow";
import { FindSession, IDLE, matchRows, type FindState, type MatchRow } from "./session";
import {
  FILE_SET_SCOPES,
  buildQuery,
  describeQuery,
  hideFindPopup,
  recentMasks,
  rememberMask,
  useFindPopup,
  type FindOptions,
  type NamedScope,
  type ScopeTab,
} from "./store";
import { ipcFindDeps, openInFindWindow } from "./windowStore";
import styles from "./FindInFiles.module.css";

const POPUP_MAX_MATCHES = 2000;
const SEARCH_DEBOUNCE_MS = 150;
const ROW = 22;

export function FindInFilesOverlay() {
  const open = useFindPopup((s) => s.open);
  return open ? <FindInFilesDialog /> : null;
}

const SCOPE_TABS: Array<{ id: ScopeTab; label: string }> = [
  { id: "project", label: "In Project" },
  { id: "directory", label: "Directory" },
  { id: "scope", label: "Scope" },
];

const NAMED_SCOPES: Array<{ value: NamedScope; label: string }> = [
  { value: "projectFiles", label: "Project Files" },
  { value: "productionFiles", label: "Project Production Files" },
  { value: "testFiles", label: "Project Test Files" },
  { value: "openFiles", label: "Open Files" },
  { value: "recentFiles", label: "Recently Viewed Files" },
];

function resolveDirectory(dir: string, root: string | null): string {
  const d = dir.trim().replace(/\/+$/, "");
  if (!d || d.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(d)) return d;
  return root ? `${root}/${d}` : d;
}

function displayDirectory(dir: string, root: string | null): string {
  if (root && dir === root) return "";
  return root && dir.startsWith(root + "/") ? dir.slice(root.length + 1) : dir;
}

function FindInFilesDialog() {
  const s = useFindPopup();
  const root = useProject((p) => p.project?.root ?? null);
  const editors = useEditorRegistry((r) => r.editors);
  const [state, setState] = useState<FindState>(IDLE);
  const [session] = useState(() => new FindSession(ipcFindDeps(), setState));
  const [index, setIndex] = useState(0);
  const [recentPaths, setRecentPaths] = useState<string[] | null>(null);
  const [maskMenu, setMaskMenu] = useState(false);
  const [confirm, setConfirm] = useState<{ usages: Usage[]; partial: boolean } | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [marks, setMarks] = useState<ReplaceMarks>(NO_MARKS);
  const [running, setRunning] = useState<ReplaceRun | null>(null);
  const [progress, setProgress] = useState<ReplaceProgress | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [diffPreview, setDiffPreview] = useState<{ key: string; lines: PreviewLine[] } | null>(null);
  const busy = !!running;
  const patternRef = useRef<HTMLInputElement>(null);
  const maskRef = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<FindOptions>) => useFindPopup.setState(patch);

  useEffect(() => () => session.dispose(), [session]);

  useEffect(() => {
    patternRef.current?.select();
  }, [s.session]);

  useEffect(() => {
    if (s.scopeTab !== "scope" || s.namedScope !== "recentFiles" || recentPaths) return;
    call(commands.recentFiles()).then(
      (p) => setRecentPaths(p.map(String)),
      () => setRecentPaths([]),
    );
  }, [s.scopeTab, s.namedScope, recentPaths]);

  const scope: SearchScope = useMemo(() => {
    if (s.scopeTab === "directory" && s.directory.trim()) return { kind: "directory", path: resolveDirectory(s.directory, root) };
    const fileSet = FILE_SET_SCOPES[s.namedScope];
    if (s.scopeTab === "scope" && fileSet) return { kind: "fileSet", set: fileSet };
    if (s.scopeTab === "scope") {
      const paths =
        s.namedScope === "openFiles"
          ? // Every open tab, not just the visible editors; `editors` only re-triggers this memo.
            [...new Set([...openEditorPaths(), ...[...editors].map((e) => e.ctx.path)])]
          : (recentPaths ?? []);
      return { kind: "files", paths };
    }
    return { kind: "project" };
  }, [s.scopeTab, s.directory, s.namedScope, root, editors, recentPaths]);

  const options: FindOptions = {
    pattern: s.pattern,
    replacement: s.replacement,
    caseSensitive: s.caseSensitive,
    wholeWord: s.wholeWord,
    isRegex: s.isRegex,
    preserveCase: s.preserveCase,
    maskEnabled: s.maskEnabled,
    mask: s.mask,
    scopeTab: s.scopeTab,
    directory: s.directory,
    namedScope: s.namedScope,
  };
  const query = useMemo(
    () => buildQuery(options, scope, POPUP_MAX_MATCHES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.pattern, s.caseSensitive, s.wholeWord, s.isRegex, s.maskEnabled, s.mask, scope],
  );
  const queryKey = JSON.stringify(query);

  const [rerun, setRerun] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      void session.search(query);
      setIndex(0);
      setMarks(NO_MARKS);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, queryKey, rerun]);

  const rows = useMemo(() => matchRows(state.files), [state.files]);
  const active = rows.length ? Math.min(index, rows.length - 1) : -1;
  const selected = active >= 0 ? rows[active] : undefined;
  const fileHighlights = useMemo(() => {
    if (!selected) return [];
    const f = state.files.find((x) => x.path === selected.path);
    return (f?.matches ?? []).map((m) => ({
      line: m.line,
      ranges: m.ranges.map(([a, b]) => [a + m.textOffset, b + m.textOffset] as [number, number]),
    }));
  }, [selected, state.files]);

  const close = () => {
    clearPreviewCache();
    hideFindPopup();
  };
  const openRow = (row: MatchRow | undefined, side = false) => {
    if (!row) return;
    close();
    setTimeout(
      () => void openLocation(row.path, { line: row.line, col: row.col, endLine: row.line, endCol: row.endCol }, { side }),
      0,
    );
  };
  const pin = () => {
    if (!s.pattern) return;
    if (s.maskEnabled) rememberMask(s.mask);
    const pinned = buildQuery(options, scope, 0);
    close();
    openInFindWindow(pinned, describeQuery(pinned, root), s.replace ? s.replacement : null, undefined, s.preserveCase);
  };

  /** Replaces `usages` in the backend, then marks them done (IDEA's Replace / Replace All). */
  const replaceUsages = async (usages: Usage[]): Promise<ReplaceMarks | null> => {
    if (!usages.length || running) return null;
    const run = startReplace(
      { query, replacement: s.replacement, preserveCase: s.preserveCase, targets: replaceTargets(usages) },
      setProgress,
    );
    setRunning(run);
    try {
      const summary = await run.result;
      notifications().notify({
        group: "search",
        level: summary.failed ? "warning" : "info",
        title: summaryText(summary),
        body: summary.files === 1 ? basename(usages[0]!.path) : undefined,
        key: "search.replace",
      });
      clearPreviewCache();
      setPreviewVersion((v) => v + 1);
      // Replacements that add or remove lines (or a stopped run) invalidate the positions found.
      if (summary.cancelled || /\n|\\n/.test(s.replacement)) {
        setRerun((r) => r + 1);
        return null;
      }
      const next = markDone(marks, usages);
      setMarks(next);
      return next;
    } catch (e) {
      notifications().notify({ group: "search", level: "error", title: "Replace failed", body: String((e as Error)?.message ?? e) });
      return null;
    } finally {
      setRunning(null);
      setProgress(null);
    }
  };

  const replaceCurrent = async () => {
    if (!selected) return;
    const next = await replaceUsages(pendingUsages([selected], marks));
    if (next) {
      const i = nextPending(rows, active, next);
      if (i >= 0) setIndex(i);
    }
  };
  const skip = () => {
    const i = nextPending(rows, active, marks);
    if (i >= 0) setIndex(i);
  };
  const replaceInFile = async () => {
    if (!selected) return;
    const next = await replaceUsages(pendingUsages(rows.filter((r) => r.path === selected.path), marks));
    if (next) {
      const i = nextPending(rows, active, next);
      if (i >= 0) setIndex(i);
    }
  };
  const replaceAll = async (usages: Usage[]) => {
    const done = await replaceUsages(usages);
    if (done) close();
  };

  useEffect(() => {
    if (!previewMode || !s.replace || !selected) return;
    let alive = true;
    const key = selected.key;
    const usages = pendingUsages([selected], marks);
    const t = setTimeout(() => {
      loadReplacePreview(query, s.replacement, s.preserveCase, selected.path, usages).then(
        (p) => alive && setDiffPreview({ key, lines: replacePreviewLines(p.before, p.edits) }),
        () => alive && setDiffPreview(null),
      );
    }, 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, s.replace, selected?.key, s.replacement, s.preserveCase, queryKey, marks, previewVersion]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const inField = target.tagName === "INPUT" && target.closest("[data-find-field]");
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const toggle = { KeyC: "caseSensitive", KeyW: "wholeWord", KeyX: "isRegex" }[e.code] as
        | "caseSensitive"
        | "wholeWord"
        | "isRegex"
        | undefined;
      if (toggle) {
        e.preventDefault();
        set({ [toggle]: !s[toggle] });
        return;
      }
    }
    if (!inField) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) pin();
      else openRow(selected, e.shiftKey);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) return;
    const next = listNavigate(e.key, { items: rows, active, pageSize: 9 });
    if (next === null) return;
    e.preventDefault();
    setIndex(next);
  };

  const summary = statusText(state);
  const maskItems: MenuItem[] = recentMasks().map((m) => ({
    label: m,
    checked: m === s.mask ? true : undefined,
    run: () => set({ mask: m, maskEnabled: true }),
  }));

  return (
    <Dialog
      open
      onClose={close}
      width={820}
      position="top"
      transparentBackdrop
      aria-label={s.replace ? "Replace in Files" : "Find in Files"}
      className={styles.dialog}
    >
      <div className={styles.root} onKeyDown={onKeyDown}>
        <header className={styles.header}>
          <span className={styles.title}>{s.replace ? "Replace in Files" : "Find in Files"}</span>
          <span className={styles.status} aria-live="polite">
            {state.status === "searching" || state.status === "validating" ? <Spinner size={12} /> : null}
            {summary}
          </span>
          <span className={styles.spacer} />
          <Checkbox checked={s.maskEnabled} onChange={(v) => set({ maskEnabled: v })} label="File mask:" />
          <div ref={maskRef} className={clsx(styles.mask, !s.maskEnabled && styles.maskOff)}>
            <input
              className={styles.maskInput}
              value={s.mask}
              placeholder="*.kt, !*Test*"
              aria-label="File mask"
              spellCheck={false}
              onChange={(e) => set({ mask: e.target.value, maskEnabled: true })}
              onBlur={() => s.maskEnabled && rememberMask(s.mask)}
            />
            <IconButton icon="chevron-down" title="Recent file masks" size="small" iconSize={11} onClick={() => setMaskMenu(true)} />
          </div>
          <IconButton icon="pin" title="Open in Find Window" shortcut="⌘↵" onClick={pin} disabled={!s.pattern} />
        </header>
        <div className={styles.fields}>
          <div data-find-field>
            <SearchField
              ref={patternRef}
              data-autofocus
              value={s.pattern}
              onChange={(v) => set({ pattern: v })}
              placeholder={s.isRegex ? "Regular expression" : "Text to find"}
              aria-label="Text to find"
              invalid={state.status === "invalid"}
              className={styles.field}
              toggles={[
                { id: "case", icon: "case", title: "Match Case", shortcut: "⌥C", pressed: s.caseSensitive, onToggle: (v) => set({ caseSensitive: v }) },
                { id: "word", icon: "word", title: "Words", shortcut: "⌥W", pressed: s.wholeWord, onToggle: (v) => set({ wholeWord: v }) },
                { id: "regex", icon: "regex", title: "Regex", shortcut: "⌥X", pressed: s.isRegex, onToggle: (v) => set({ isRegex: v }) },
              ]}
            />
          </div>
          {state.status === "invalid" && state.error && <div className={styles.error}>{state.error}</div>}
          {s.replace && (
            <div data-find-field>
              <SearchField
                value={s.replacement}
                onChange={(v) => set({ replacement: v })}
                leadingIcon="replace"
                placeholder="Replace with"
                aria-label="Replace with"
                className={styles.field}
                toggles={[
                  {
                    id: "preserveCase",
                    icon: "preserve-case",
                    title: "Preserve Case",
                    pressed: s.preserveCase,
                    onToggle: (v) => set({ preserveCase: v }),
                  },
                ]}
              />
            </div>
          )}
        </div>
        <div className={styles.scopeRow}>
          <Tabs
            variant="compact"
            aria-label="Search scope"
            items={SCOPE_TABS.map((t) => ({ id: t.id, label: t.label }))}
            activeId={s.scopeTab}
            onSelect={(id) => {
              // IDEA starts the Directory scope at the current file's folder.
              if (id === "directory" && !s.directory.trim()) {
                const active = maybeEditorService()?.activePath();
                const dir = active && root && active.startsWith(root + "/") ? dirname(active) : root;
                set({ scopeTab: "directory", directory: dir ?? "" });
              } else set({ scopeTab: id as ScopeTab });
            }}
          />
          <div className={styles.scopeDetail}>
            {s.scopeTab === "directory" && (
              <input
                className={styles.dirInput}
                value={displayDirectory(s.directory, root)}
                placeholder="Directory (relative to project root)"
                aria-label="Directory"
                spellCheck={false}
                // Keep the raw text (resolved only when searching), or a typed "/" would be stripped.
                onChange={(e) => set({ directory: e.target.value })}
              />
            )}
            {s.scopeTab === "scope" && (
              <Select<NamedScope>
                value={s.namedScope}
                options={NAMED_SCOPES}
                onChange={(v) => set({ namedScope: v })}
                aria-label="Named scope"
              />
            )}
          </div>
        </div>
        <div className={styles.results}>
          <List<MatchRow>
            items={rows}
            getKey={(r, i) => `${r.key}:${i}`}
            activeIndex={active}
            onActiveChange={setIndex}
            onActivate={(r, _i, e) => {
              if (e.type === "click" && (e as MouseEvent).detail < 2) return;
              openRow(r, e.shiftKey);
            }}
            focusable={false}
            rowHeight={ROW}
            aria-label="Matches"
            empty={<span>{emptyText(state, s.pattern)}</span>}
            renderItem={(r, st) => {
              const state = s.replace ? groupState(r, marks) : "pending";
              return (
              <>
                <span className={clsx(styles.rowText, state === "done" && styles.rowDone, state === "excluded" && styles.rowExcluded)}>
                  <MatchText
                    text={r.text}
                    ranges={r.ranges}
                    active={st.active}
                    replacement={s.replace && state !== "done" ? s.replacement : null}
                    query={query}
                    preserveCase={s.preserveCase}
                  />
                </span>
                <span className={clsx(styles.rowFile, st.active && styles.rowFileActive)}>
                  {state === "done" && <span className={styles.rowLine}>replaced · </span>}
                  {basename(r.relPath)} <span className={styles.rowLine}>{r.line + 1}</span>
                </span>
              </>
              );
            }}
          />
        </div>
        <div className={styles.previewHeader}>
          {selected ? (
            <>
              <span className={styles.previewPath}>{selected.relPath}</span>
              <span className={styles.rowLine}>
                {selected.line + 1}:{selected.col + 1}
              </span>
            </>
          ) : (
            <span />
          )}
        </div>
        <div className={styles.previewBox}>
          {previewMode && s.replace && selected ? (
            <ReplaceDiffPreview lines={diffPreview?.key === selected.key ? diffPreview.lines : null} line={selected.line} />
          ) : (
            <CodePreview path={selected?.path ?? null} line={selected?.line ?? 0} highlights={fileHighlights} version={previewVersion} />
          )}
        </div>
        <footer className={styles.footer}>
          <span className={styles.hint}>↵ Open · ⇧↵ Open to the side · ⌘↵ Open in Find Window</span>
          <span className={styles.spacer} />
          {s.replace && progress && (
            <span className={styles.hint} aria-live="polite">
              Replacing… {progress.done}/{progress.total} files
            </span>
          )}
          {s.replace && running && (
            <Button size="small" onClick={() => running.cancel()}>
              Stop
            </Button>
          )}
          {s.replace && (
            <>
              <Checkbox checked={previewMode} onChange={setPreviewMode} label="Preview" />
              <Button size="small" variant="secondary" disabled={!selected || busy} onClick={skip}>
                Skip
              </Button>
              <Button size="small" disabled={!selected || busy} onClick={() => void replaceCurrent()}>
                Replace
              </Button>
              <Button size="small" disabled={!selected || busy} onClick={() => void replaceInFile()}>
                Replace All in This File
              </Button>
              <Button
                size="small"
                disabled={!rows.length || busy || state.status === "searching"}
                onClick={() => setConfirm({ usages: pendingUsages(rows, marks), partial: !!state.summary?.limitHit })}
              >
                Replace All
              </Button>
            </>
          )}
          <Button size="small" variant={s.replace ? "secondary" : "primary"} disabled={!s.pattern} onClick={pin}>
            Open in Find Window
          </Button>
        </footer>
      </div>
      <Menu open={maskMenu} anchor={maskRef} items={maskItems} placement="bottom-end" onClose={() => setMaskMenu(false)} />
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        width={420}
        title="Replace All"
        buttons={[
          {
            label: "Replace",
            role: "default",
            autoFocus: true,
            disabled: !confirm?.usages.length,
            onClick: () => {
              const usages = confirm?.usages ?? [];
              setConfirm(null);
              void replaceAll(usages);
            },
          },
          { label: "Cancel", role: "cancel" },
        ]}
      >
        <p className={styles.confirm}>
          {confirm && confirmText(countUsages(confirm.usages), s.pattern, s.replacement || "")}
          {confirm && marks.excluded.size > 0 && <span> Excluded usages are skipped.</span>}
          {confirm?.partial && <span className={styles.warn}> The search hit its limit; only usages found so far are replaced.</span>}
        </p>
      </Dialog>
    </Dialog>
  );
}

function statusText(s: FindState): string {
  if (s.status === "invalid") return "Invalid pattern";
  if (s.status === "error") return s.error ?? "Search failed";
  if (s.status === "idle") return "";
  const files = s.files.length;
  const more = s.summary?.limitHit ? "+" : "";
  if (!s.matchCount) return s.status === "done" ? "No matches" : "Searching…";
  return `${s.matchCount}${more} match${s.matchCount === 1 ? "" : "es"} in ${files}${more} file${files === 1 ? "" : "s"}`;
}

function emptyText(s: FindState, pattern: string): string {
  if (!pattern) return "Type text to search the project";
  if (s.status === "invalid") return s.error ?? "Invalid pattern";
  if (s.status === "searching" || s.status === "validating") return "Searching…";
  if (s.status === "error") return s.error ?? "Search failed";
  return "Nothing found";
}
