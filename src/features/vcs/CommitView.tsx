/** Commit tool window: change list with inclusion checkboxes, message, stashes. */
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import {
  Button,
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  List,
  Menu,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
  T,
} from "@/ui";
import { editorService } from "@/workbench/contributions";
import {
  aggregateCheck,
  buildChangeTree,
  checkOf,
  filesOf,
  isPartiallyStaged,
  planCommit,
  toggledCheck,
  type ChangeNode,
} from "./changes";
import { applyStash, commitChanges, dropStash, stashChanges } from "./changeOps";
import { useChangelists, withListDefaults } from "./changelists";
import { moveToChangelist } from "./changelistsUi";
import { messageHistory, setGroupByDir, useCommit, type CommitTab } from "./commitStore";
import { openDiff, workingDiffData } from "./diffInput";
import { KIND_COLOR, KIND_LABEL, formatTime, stashLabel, stripSlash } from "./model";
import { call, commands } from "@/platform/ipc";
import { OperationBanner } from "./operations";
import { ShelfPanel, loadShelves, useShelf } from "./shelf";
import { loadStashes, refreshNow, useVcs } from "./store";
import styles from "./CommitView.module.css";

/** MIME type of changed files dragged between change lists (absolute paths, newline-separated). */
const CHANGES_MIME = "application/x-openidea-changes";

/** "Changes" / "Stashes" tabs in the tool window header. */
export function CommitTabs() {
  const available = useVcs((s) => s.available);
  const tab = useCommit((s) => s.tab);
  const stashCount = useVcs((s) => s.stashes.length);
  const shelfCount = useShelf((s) => s.shelves.length);
  useEffect(() => {
    if (available) void loadShelves().catch(() => undefined);
  }, [available]);
  if (!available) return null;
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      activeId={tab}
      onSelect={(id) => useCommit.setState({ tab: id as CommitTab })}
      aria-label="Commit"
      items={[
        { id: "changes", label: "Changes" },
        ...(shelfCount || tab === "shelf"
          ? [
              {
                id: "shelf",
                label: "Shelf",
                trailing: shelfCount ? <span className={styles.count}>{shelfCount}</span> : undefined,
              },
            ]
          : []),
        {
          id: "stashes",
          label: "Stashes",
          trailing: stashCount ? <span className={styles.count}>{stashCount}</span> : undefined,
        },
      ]}
    />
  );
}

export function CommitToolWindow() {
  const available = useVcs((s) => s.available);
  const tab = useCommit((s) => s.tab);
  if (!available)
    return (
      <EmptyState icon="commit" title="Version control is not configured">
        <T>Open a Git repository to commit changes.</T>
      </EmptyState>
    );
  return (
    <div className={styles.root}>
      {tab === "changes" ? <ChangesPanel /> : tab === "shelf" ? <ShelfPanel /> : <StashesPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function openNode(n: ChangeNode) {
  if (n.type !== "file" || !n.path) return;
  void openDiff(workingDiffData(n.path), { preview: true });
}

function listMenu(id: string, active: boolean, paths: string[]): MenuItem[] {
  const count = paths.length;
  return [
    ...(count ? [{ kind: "action" as const, action: "vcs.changelist.commit", arg: id, label: "Commit…" }] : []),
    { kind: "separator" },
    { kind: "action", action: "vcs.changelist.new" },
    { kind: "action", action: "vcs.changelist.edit", arg: id },
    ...(active
      ? []
      : [
          { kind: "action" as const, action: "vcs.changelist.setActive", arg: id },
          { kind: "action" as const, action: "vcs.changelist.delete", arg: id },
        ]),
    { kind: "separator" },
    ...(count
      ? [
          { kind: "action" as const, action: "vcs.shelve", arg: paths },
          { kind: "action" as const, action: "vcs.createPatch", arg: paths },
        ]
      : []),
  ];
}

function nodeMenu(nodes: ChangeNode[]): MenuItem[] {
  const files = filesOf(nodes);
  const paths = files.map((f) => f.path);
  const first = nodes.find((n) => n.type === "file");
  const untracked = files.filter((f) => f.unstaged === "untracked");
  const conflicted = files.filter((f) => f.unstaged === "conflicted");
  const items: MenuItem[] = [
    { kind: "action", action: "vcs.showDiff", arg: first?.path },
    {
      label: "Jump to Source",
      icon: "external-link",
      shortcut: "F4",
      disabled: !first?.path || first.kind === "deleted",
      run: () => first?.path && void editorService().openFile(first.path, { focus: true }),
    },
    { kind: "separator" },
  ];
  if (conflicted.length) items.push({ kind: "action", action: "vcs.resolveConflicts", label: "Resolve Conflicts…" });
  items.push(
    { kind: "action", action: "vcs.rollback", arg: paths, label: "Rollback…" },
    ...(untracked.length
      ? [{ kind: "action" as const, action: "vcs.addToVcs", arg: untracked.map((f) => f.path) }]
      : []),
    {
      label: "Stage",
      icon: "plus",
      disabled: !files.some((f) => f.unstaged),
      run: () => void call(commands.vcsStage(paths)).finally(() => void refreshNow()),
    },
    {
      label: "Unstage",
      icon: "minus",
      disabled: !files.some((f) => f.staged),
      run: () => void call(commands.vcsUnstage(paths)).finally(() => void refreshNow()),
    },
    { kind: "separator" },
    ...(nodes.some((n) => n.changelist)
      ? [{ kind: "action" as const, action: "vcs.changelist.move", arg: paths, label: "Move to Another Changelist…" }]
      : []),
    { kind: "action", action: "vcs.shelve", arg: paths },
    { kind: "action", action: "vcs.createPatch", arg: paths },
    { kind: "separator" },
    {
      label: "Show History",
      icon: "history",
      disabled: !first?.path,
      run: () => void executeAction("vcs.showLog", { path: first?.path }),
    },
    { kind: "action", action: "vcs.localHistory", arg: first?.path },
    { kind: "action", action: "vcs.annotate", arg: first?.path },
    { kind: "separator" },
    { label: "Copy Path", icon: "copy", run: () => void navigator.clipboard?.writeText(paths.join("\n")) },
  );
  return items;
}

function CheckMark({
  checked,
  indeterminate,
  label,
  onToggle,
}: {
  checked: boolean;
  indeterminate: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      className={clsx(styles.check, (checked || indeterminate) && styles.checkOn)}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {indeterminate ? <Icon name="minus" size={10} /> : checked ? <Icon name="check" size={10} /> : null}
    </span>
  );
}

function ChangesPanel() {
  const status = useVcs((s) => s.status);
  const root = useVcs((s) => s.root) ?? "";
  const groupByDir = useCommit((s) => s.groupByDir);
  const userChecks = useCommit((s) => s.checks);
  const lists = useChangelists((s) => s.state);
  const checks = useMemo(() => withListDefaults(status, root, lists, userChecks), [status, root, lists, userChecks]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const treeRef = useRef<TreeHandle>(null);

  const roots = useMemo(() => buildChangeTree(status, root, groupByDir, lists), [status, root, groupByDir, lists]);
  const byKey = useMemo(() => {
    const m = new Map<string, ChangeNode>();
    const walk = (ns: ChangeNode[]) =>
      ns.forEach((n) => {
        m.set(n.key, n);
        if (n.children) walk(n.children);
      });
    walk(roots);
    return m;
  }, [roots]);
  const expanded = useMemo(() => {
    const s = new Set<string>();
    for (const k of byKey.keys()) if (!collapsed.has(k)) s.add(k);
    return s;
  }, [byKey, collapsed]);

  // Forget overrides for files that are no longer changed.
  useEffect(() => {
    const live = new Set(status.map((f) => f.path));
    const cur = useCommit.getState().checks;
    if ([...cur.keys()].some((k) => !live.has(k))) {
      useCommit.setState({ checks: new Map([...cur].filter(([k]) => live.has(k))) });
    }
  }, [status]);

  const toggle = useCallback((nodes: ChangeNode[]) => {
    const files = filesOf(nodes);
    const { status: st, root: r } = useVcs.getState();
    const cur = withListDefaults(st, r ?? "", useChangelists.getState().state, useCommit.getState().checks);
    const agg = aggregateCheck(files, cur);
    const target = agg.on === files.length && !agg.indeterminate ? "none" : "all";
    const next = new Map(cur);
    for (const f of files) next.set(f.path, files.length === 1 ? toggledCheck(checkOf(f, cur)) : target);
    useCommit.setState({ checks: next });
  }, []);

  const selectedNodes = () => [...selected].map((k) => byKey.get(k)).filter((n): n is ChangeNode => !!n);

  const plan = useMemo(() => planCommit(status, checks), [status, checks]);

  return (
    <SplitGroup orientation="vertical" className={styles.split}>
      <SplitPanel defaultSize="62%" minSize="20%">
        <div className={styles.changes}>
          <div className={styles.toolbar} role="toolbar" aria-label="Changes">
            <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void refreshNow()} />
            <IconButton icon="undo" action="vcs.rollback" size="small" />
            <IconButton icon="diff" action="vcs.showDiff" size="small" />
            <span className={styles.sep} />
            <IconButton
              icon="folder"
              title="Group by Directory"
              size="small"
              pressed={groupByDir}
              onClick={() => setGroupByDir(!groupByDir)}
            />
            <IconButton icon="expand-all" title="Expand All" size="small" onClick={() => setCollapsed(new Set())} />
            <IconButton
              icon="collapse-all"
              title="Collapse All"
              size="small"
              onClick={() =>
                setCollapsed(new Set([...byKey.values()].filter((n) => n.type === "dir").map((n) => n.key)))
              }
            />
            <span className={styles.sep} />
            <IconButton icon="changelist" action="vcs.changelist.new" size="small" />
            <IconButton icon="shelve" action="vcs.shelve" size="small" />
            <IconButton icon="stash" action="vcs.stash" size="small" />
          </div>
          <OperationBanner />
          <div
            className={styles.treeWrap}
            onKeyDownCapture={(e) => {
              if (e.key === " " && !e.metaKey && !e.ctrlKey && selected.size) {
                e.preventDefault();
                e.stopPropagation();
                toggle(selectedNodes());
              } else if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey) {
                const group = selectedNodes().find((x) => x.type === "group" && x.changelist);
                if (group?.changelist) {
                  e.preventDefault();
                  e.stopPropagation();
                  void executeAction("vcs.changelist.delete", group.changelist);
                }
              } else if (e.key === "F4") {
                const n = selectedNodes().find((x) => x.type === "file");
                if (n?.path) {
                  e.preventDefault();
                  void editorService().openFile(n.path, { focus: true });
                }
              }
            }}
          >
            <Tree<ChangeNode>
              handleRef={treeRef}
              roots={roots}
              getKey={(n) => n.key}
              getLabel={(n) => n.label}
              getChildren={(n) => n.children}
              isExpandable={(n) => n.type !== "file"}
              expanded={expanded}
              onExpandedChange={(_next, node, open) =>
                setCollapsed((c) => {
                  const s = new Set(c);
                  if (open) s.delete(node.key);
                  else s.add(node.key);
                  return s;
                })
              }
              selected={selected}
              onSelectionChange={(sel) => {
                setSelected(sel);
                const nodes = [...sel].map((k) => byKey.get(k)).filter((n): n is ChangeNode => !!n);
                useCommit.setState({
                  selection: filesOf(nodes).map((f) => f.path),
                  selectedList: nodes.find((n) => n.changelist)?.changelist ?? null,
                });
              }}
              onActivate={openNode}
              onContextMenu={(node, sel, e: MouseEvent) => {
                if (!node) return;
                if (node.type === "group" && node.changelist) {
                  const paths = node.files.map((f) => stripSlash(f.path));
                  showContextMenu(e, listMenu(node.changelist, !!node.active, paths));
                  return;
                }
                const nodes = [...sel].map((k) => byKey.get(k)).filter((n): n is ChangeNode => !!n);
                showContextMenu(e, nodeMenu(nodes.length ? nodes : [node]));
              }}
              aria-label="Changes"
              empty={
                <span className={styles.empty}>
                  <T>No local changes</T>
                </span>
              }
              renderNode={(n, st) => {
                const agg = aggregateCheck(n.files, checks);
                const label = (
                  <span
                    className={clsx(
                      styles.label,
                      n.type === "group" && styles.groupLabel,
                      n.type === "group" && n.changelist && !n.active && styles.inactiveList,
                    )}
                    style={n.type === "file" && n.kind ? { color: KIND_COLOR[n.kind] } : undefined}
                    title={n.type === "file" && n.kind ? KIND_LABEL[n.kind] : undefined}
                  >
                    {n.label}
                  </span>
                );
                const dnd =
                  n.changelist !== undefined
                    ? {
                        draggable: n.type !== "group",
                        onDragStart: (e: DragEvent<HTMLSpanElement>) => {
                          const paths =
                            selected.has(n.key) && selected.size > 1
                              ? filesOf(selectedNodes()).map((f) => f.path)
                              : n.files.map((f) => f.path);
                          e.dataTransfer.setData(CHANGES_MIME, paths.map(stripSlash).join("\n"));
                          e.dataTransfer.effectAllowed = "move";
                        },
                        onDragOver: (e: DragEvent<HTMLSpanElement>) => {
                          if (![...e.dataTransfer.types].includes(CHANGES_MIME)) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (dropTarget !== n.changelist) setDropTarget(n.changelist ?? null);
                        },
                        onDragLeave: () => setDropTarget(null),
                        onDrop: (e: DragEvent<HTMLSpanElement>) => {
                          const data = e.dataTransfer.getData(CHANGES_MIME);
                          setDropTarget(null);
                          if (!data || !n.changelist) return;
                          e.preventDefault();
                          moveToChangelist(data.split("\n"), n.changelist);
                        },
                        onDragEnd: () => setDropTarget(null),
                      }
                    : {};
                return (
                  <span
                    className={clsx(
                      styles.nodeRow,
                      n.type === "group" && dropTarget === n.changelist && styles.dropTarget,
                    )}
                    {...dnd}
                  >
                    <CheckMark
                      checked={agg.checked}
                      indeterminate={agg.indeterminate}
                      label={`Include ${n.label} in commit`}
                      onToggle={() => toggle(selected.has(n.key) && selected.size > 1 ? selectedNodes() : [n])}
                    />
                    {n.type === "group" ? null : (
                      <Icon
                        name={n.type === "dir" ? (st.expanded ? "folder-open" : "folder") : fileIconName(n.label)}
                        size={16}
                        className={styles.icon}
                      />
                    )}
                    {label}
                    {n.type === "group" && (
                      <span className={styles.detail}>
                        {n.files.length} file{n.files.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {n.type === "file" && n.files[0] && isPartiallyStaged(n.files[0]) && (
                      <span className={styles.partial} title="Partially staged: only staged hunks are committed">
                        partial
                      </span>
                    )}
                    {n.detail && <span className={styles.detail}>{n.detail}</span>}
                  </span>
                );
              }}
            />
          </div>
        </div>
      </SplitPanel>
      <SplitHandle />
      <SplitPanel defaultSize="38%" minSize="120px">
        <CommitMessage included={plan.included.length} />
      </SplitPanel>
    </SplitGroup>
  );
}

/** Commit message inspections (Settings › Version Control › Commit). */
export function messageProblems(
  message: string,
  c: {
    blankLineAfterSubject: boolean;
    limitSubject: boolean;
    subjectLimit: number;
    limitBody: boolean;
    bodyLimit: number;
  },
): string[] {
  const lines = message.split("\n");
  const out: string[] = [];
  if (c.limitSubject && (lines[0]?.length ?? 0) > c.subjectLimit)
    out.push(`Subject line is longer than ${c.subjectLimit} characters`);
  if (c.blankLineAfterSubject && lines.length > 1 && lines[1]!.trim() !== "")
    out.push("Missing blank line between subject and body");
  if (c.limitBody) {
    const long = lines.slice(1).findIndex((l) => l.length > c.bodyLimit);
    if (long >= 0) out.push(`Body line ${long + 2} is longer than ${c.bodyLimit} characters`);
  }
  return out;
}

/** "Wrap when typing reaches right margin": breaks the caret line at the last space before `limit`. */
export function wrapAtMargin(text: string, caret: number, limit: number): { text: string; caret: number } | null {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const end = text.indexOf("\n", caret);
  const line = text.slice(start, end < 0 ? text.length : end);
  if (start === 0 || line.length <= limit) return null; // the subject line is never wrapped
  const cut = line.lastIndexOf(" ", limit);
  if (cut <= 0) return null;
  const at = start + cut;
  return { text: `${text.slice(0, at)}\n${text.slice(at + 1)}`, caret };
}

function CommitMessage({ included }: { included: number }) {
  const message = useCommit((s) => s.message);
  const amend = useCommit((s) => s.amend);
  const signOff = useCommit((s) => s.signOff);
  const focusTick = useCommit((s) => s.focusTick);
  const remoteBusy = useVcs((s) => s.remoteBusy);
  const merging = useVcs((s) => s.branch?.operation === "merge");
  const ref = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const amendMessage = useRef<string | null>(null);

  useEffect(() => {
    if (focusTick) ref.current?.focus();
  }, [focusTick]);

  const cfg = useWorkflowSettings((s) => s.vcs.commit);
  const first = message.split("\n")[0] ?? "";
  const tooLong = cfg.limitSubject && first.length > cfg.subjectLimit;
  const problems = messageProblems(message, cfg).filter((p) => !p.startsWith("Subject line"));
  const margin = cfg.limitBody ? cfg.bodyLimit : cfg.subjectLimit;
  const showMargin = cfg.showRightMargin && (cfg.limitBody || cfg.limitSubject);

  const setAmend = async (v: boolean) => {
    useCommit.setState({ amend: v });
    if (v && !useCommit.getState().message.trim()) {
      try {
        const [last] = await call(
          commands.vcsLog({ branch: "HEAD", path: null, author: null, text: null, range: null, skip: 0, limit: 1 }),
        );
        if (last && !useCommit.getState().message.trim()) {
          amendMessage.current = last.message;
          useCommit.setState({ message: last.message });
        }
      } catch {
        // No commits yet.
      }
    } else if (!v && amendMessage.current !== null && useCommit.getState().message === amendMessage.current) {
      useCommit.setState({ message: "" });
      amendMessage.current = null;
    }
  };

  const commit = async (push: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await commitChanges();
      amendMessage.current = null;
      if (id !== undefined && push) void executeAction("vcs.push");
    } finally {
      setBusy(false);
    }
  };

  const history = messageHistory();
  const canCommit = (included > 0 || amend || merging) && (!!message.trim() || amend) && !busy;

  return (
    <div className={styles.commit}>
      <div className={styles.commitBar}>
        <Checkbox checked={amend} onChange={(v) => void setAmend(v)} label="Amend" />
        <span className={styles.grow} />
        {tooLong && (
          <span className={clsx(styles.lineLen, styles.lineLenWarn)} title="Subject line length">
            {first.length}/{cfg.subjectLimit}
          </span>
        )}
        <IconButton
          ref={historyRef}
          icon="history"
          title="Commit Message History"
          size="small"
          disabled={!history.length}
          aria-haspopup="menu"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((o) => !o)}
        />
        <Menu
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          anchor={historyRef}
          placement="bottom-end"
          aria-label="Recent commit messages"
          items={history.map((m, i) => ({
            id: `h${i}`,
            label: m.split("\n")[0]!.slice(0, 80),
            run: () => {
              useCommit.setState({ message: m });
              ref.current?.focus();
            },
          }))}
        />
      </div>
      <textarea
        ref={ref}
        className={clsx(styles.message, !showMargin && styles.noMargin)}
        style={{ ["--guide" as string]: `${margin}ch` }}
        value={message}
        placeholder="Commit Message"
        aria-label="Commit message"
        spellCheck
        onChange={(e) => {
          const el = e.target;
          const wrapped =
            cfg.limitBody && cfg.wrapAtMargin ? wrapAtMargin(el.value, el.selectionStart, cfg.bodyLimit) : null;
          useCommit.setState({ message: wrapped?.text ?? el.value });
          if (wrapped) requestAnimationFrame(() => el.setSelectionRange(wrapped.caret, wrapped.caret));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void commit(e.altKey);
          } else if (e.key === "Escape") {
            e.currentTarget.blur();
          }
        }}
      />
      {problems.length > 0 && (
        <div className={styles.inspections} role="status">
          {problems.join(" · ")}
        </div>
      )}
      <div className={styles.commitActions}>
        <Button variant="primary" disabled={!canCommit} onClick={() => void commit(false)} title="⌘↩">
          {amend ? "Amend Commit" : "Commit"}
        </Button>
        <Button disabled={!canCommit || !!remoteBusy} onClick={() => void commit(true)} title="⌥⌘↩">
          {amend ? "Amend and Push…" : "Commit and Push…"}
        </Button>
        <span className={styles.grow} />
        <IconButton
          icon="settings"
          title="Commit Options"
          size="small"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showContextMenu({ x: r.left, y: r.top - 4 }, [
              { kind: "header", label: "Git" },
              {
                label: "Sign-off Commit",
                checked: signOff,
                run: () => useCommit.setState({ signOff: !signOff }),
              },
              { kind: "header", label: `${included} file${included === 1 ? "" : "s"} included` },
            ]);
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StashesPanel() {
  const stashes = useVcs((s) => s.stashes);
  const loaded = useVcs((s) => s.stashesLoaded);
  const [active, setActive] = useState(0);
  useEffect(() => {
    void loadStashes().catch(() => undefined);
  }, []);
  const current = stashes[active];
  return (
    <div className={styles.changes}>
      <div className={styles.toolbar} role="toolbar" aria-label="Stashes">
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void loadStashes()} />
        <IconButton icon="plus" title="Stash Changes…" size="small" onClick={() => void stashChanges()} />
        <span className={styles.sep} />
        <IconButton
          icon="check"
          title="Apply Stash"
          size="small"
          disabled={!current}
          onClick={() => current && void applyStash(current.index, false)}
        />
        <IconButton
          icon="undo"
          title="Pop Stash (Apply and Drop)"
          size="small"
          disabled={!current}
          onClick={() => current && void applyStash(current.index, true)}
        />
        <IconButton
          icon="trash"
          title="Drop Stash"
          size="small"
          disabled={!current}
          onClick={() => current && void dropStash(current.index, current.message)}
        />
      </div>
      <List
        items={stashes}
        getKey={(s) => String(s.index)}
        activeIndex={Math.min(active, Math.max(0, stashes.length - 1))}
        onActiveChange={setActive}
        rowHeight={22}
        aria-label="Stashes"
        className={styles.stashList}
        empty={<span className={styles.empty}>{loaded ? "No stashes" : "Loading…"}</span>}
        onActivate={(s, _i, e) => {
          if (e.type === "click" && (e as MouseEvent).detail < 2) return;
          void applyStash(s.index, false);
        }}
        onContextMenu={(s, i, e) => {
          e.preventDefault();
          setActive(i);
          showContextMenu(e, [
            { label: "Apply Stash", icon: "check", run: () => void applyStash(s.index, false) },
            { label: "Pop Stash", icon: "undo", run: () => void applyStash(s.index, true) },
            { kind: "separator" },
            { label: "Drop Stash", icon: "trash", run: () => void dropStash(s.index, s.message) },
          ]);
        }}
        renderItem={(s) => {
          const { branch, text } = stashLabel(s.message);
          return (
            <span className={styles.stashRow} title={`stash@{${s.index}}: ${s.message}`}>
              <span className={styles.stashMessage}>{text}</span>
              {branch && <span className={styles.detail}>{branch}</span>}
              <span className={styles.detail}>{formatTime(s.timeMs)}</span>
            </span>
          );
        }}
      />
    </div>
  );
}
