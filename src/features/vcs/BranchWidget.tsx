/** Title bar branch widget (branch name + incoming / outgoing markers) + Branches popup. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import {
  BarButton,
  HighlightedText,
  Icon,
  IconButton,
  List,
  listNavigate,
  MenuList,
  Popup,
  SearchField,
  firstSelectable,
  type MenuItem,
} from "@/ui";
import { buildBranchRows, type BranchRow, type PopupAction } from "./branches";
import { branchMenu, tagMenu } from "./branchMenu";
import { loadFavoriteBranches, recentBranches, toggleFavoriteBranch, useFavoriteBranches } from "./branchOps";
import { inProgress, operationTitle, type InProgress } from "./operations";
import { currentRepo, loadBranches, repoName, selectRepo, useVcs } from "./store";
import styles from "./BranchWidget.module.css";

export const useBranchesPopup = create<{ open: boolean }>(() => ({ open: false }));
export const showBranchesPopup = () => useBranchesPopup.setState({ open: true });

export function headLabel(branch: { head: string | null; headCommit: string | null } | null): string {
  if (!branch) return "";
  if (branch.head) return branch.head;
  return branch.headCommit ? branch.headCommit.slice(0, 8) : "No commits";
}

export function BranchWidget() {
  const available = useVcs((s) => s.available);
  const branch = useVcs((s) => s.branch);
  // With several repositories the widget names the selected one, like IDEA's.
  const repo = useVcs((s) => (s.roots.length > 1 && s.repo ? repoName(s.repo) : null));
  const open = useBranchesPopup((s) => s.open);
  const ref = useRef<HTMLButtonElement>(null);
  if (!available || !branch) return null;
  const op = branch.operation ? ` (${branch.operation})` : "";
  const sync = [
    branch.behind > 0 ? `${branch.behind} incoming` : "",
    branch.ahead > 0 ? `${branch.ahead} outgoing` : "",
  ].filter(Boolean);
  const tooltip =
    (repo ? `Repository: ${repo}\n` : "") +
    (branch.upstream
      ? `Git branch: ${headLabel(branch)}${op}\nTracking ${branch.upstream}`
      : `Git branch: ${headLabel(branch)}${op}`) +
    (sync.length ? `\n${sync.join(", ")} commits` : "");
  return (
    <>
      <BarButton
        ref={ref}
        variant="title"
        className={styles.widget}
        tooltip={tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => useBranchesPopup.setState({ open: !open })}
      >
        <Icon name={branch.head ? "branch" : "commit"} size={16} className={styles.icon} />
        {repo && <span className={styles.repo}>{repo}</span>}
        <span className={styles.name}>
          {inProgress(branch.operation)
            ? operationTitle(inProgress(branch.operation)!, branch.head)
            : headLabel(branch)}
        </span>
        {branch.operation && !inProgress(branch.operation) && (
          <span className={styles.operation}>{branch.operation}</span>
        )}
        {/* Like IDEA's widget: icons only; counts are in the tooltip. */}
        {branch.behind > 0 && <Icon name="vcs-incoming" size={12} className={styles.sync} label="Incoming commits" />}
        {branch.ahead > 0 && <Icon name="vcs-outgoing" size={12} className={styles.sync} label="Outgoing commits" />}
        <Icon name="chevron-down" size={14} className={styles.chevron} />
      </BarButton>
      {open && <BranchesPopup anchor={ref} onClose={() => useBranchesPopup.setState({ open: false })} />}
    </>
  );
}

const POPUP_ACTIONS: PopupAction[] = [
  { id: "vcs.update", label: "Update Project…", icon: "git-pull" },
  { id: "vcs.commit", label: "Commit…", icon: "commit" },
  { id: "vcs.push", label: "Push…", icon: "git-push" },
  { id: "vcs.newBranch", label: "New Branch…", icon: "plus" },
  { id: "vcs.checkoutRevision", label: "Checkout Tag or Revision…", icon: "branch" },
];

/** Entries IDEA puts at the top of the Branches popup while an operation is stopped. */
export function operationActions(op: InProgress | null, conflicts: number): PopupAction[] {
  if (!op) return [];
  const out: PopupAction[] = [];
  if (conflicts) out.push({ id: "vcs.resolveConflicts", label: "Resolve Conflicts…", icon: "warning" });
  const ids: Record<InProgress, Array<[string, string]>> = {
    rebase: [
      ["vcs.rebase.continue", "Continue Rebase"],
      ["vcs.rebase.skip", "Skip Commit"],
      ["vcs.rebase.abort", "Abort Rebase"],
    ],
    merge: [["vcs.merge.abort", "Abort Merge"]],
    "cherry-pick": [
      ["vcs.cherryPick.continue", "Continue Cherry-Pick"],
      ["vcs.cherryPick.abort", "Abort Cherry-Pick"],
    ],
    revert: [
      ["vcs.revert.continue", "Continue Revert"],
      ["vcs.revert.abort", "Abort Revert"],
    ],
    am: [],
  };
  for (const [id, label] of ids[op]) out.push({ id, label });
  return out;
}

function BranchesPopup({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const branches = useVcs((s) => s.branches);
  const loaded = useVcs((s) => s.branchesLoaded);
  const current = useVcs((s) => s.branch?.head ?? null);
  const [query, setQuery] = useState("");
  const [recent] = useState(recentBranches);
  const [active, setActive] = useState(0);
  const [menuFor, setMenuFor] = useState<{ items: MenuItem[]; label: string; el: HTMLElement } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const repo = useVcs((s) => s.repo);
  const favorites = useFavoriteBranches((s) => s.names);
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    void loadBranches().catch(() => undefined);
    loadFavoriteBranches();
  }, []);
  useEffect(() => {
    let live = true;
    call(commands.vcsTags(currentRepo())).then(
      (t) => live && setTags(t),
      () => live && setTags([]),
    );
    return () => {
      live = false;
    };
  }, [repo, branches]);

  const op = useVcs((s) => inProgress(s.branch?.operation));
  const conflicts = useVcs((s) => s.status.filter((f) => f.unstaged === "conflicted").length);
  const actions = useMemo(() => [...operationActions(op, conflicts), ...POPUP_ACTIONS], [op, conflicts]);
  const rows = useMemo(
    () => buildBranchRows(branches, recent, query, actions, favorites, tags),
    [branches, recent, query, actions, favorites, tags],
  );
  const isSection = (r: BranchRow) => r.type === "section";
  const activeIndex = rows[active] && !isSection(rows[active]!) ? active : firstSelectable(rows, isSection);

  const closeAll = () => {
    setMenuFor(null);
    onClose();
  };
  const openMenu = (i: number) => {
    const row = rows[i];
    if (row?.type !== "branch" && row?.type !== "tag") return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(row.key)}"]`);
    if (!el) return;
    const anchorEl = (el.closest('[role="option"]') as HTMLElement | null) ?? el;
    setMenuFor(
      row.type === "branch"
        ? { items: branchMenu(row.branch, current, closeAll), label: `Branch ${row.branch.name}`, el: anchorEl }
        : { items: tagMenu(row.tag, closeAll), label: `Tag ${row.tag}`, el: anchorEl },
    );
  };

  const activate = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.type === "action") {
      onClose();
      void executeAction(row.action.id, row.action.arg);
    } else if (row.type === "branch" || row.type === "tag") {
      openMenu(i);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      activate(activeIndex);
      return;
    }
    const type = rows[activeIndex]?.type;
    if (e.key === "ArrowRight" && (type === "branch" || type === "tag")) {
      const input = e.target as HTMLInputElement;
      if (input.selectionStart === input.value.length) {
        e.preventDefault();
        openMenu(activeIndex);
      }
      return;
    }
    const next = listNavigate(e.key, { items: rows, active: activeIndex, isSection, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  const rowHeight = 24;
  const height = Math.min(440, Math.max(rowHeight * 3, rows.length * rowHeight));

  return (
    <Popup
      open
      anchor={anchor}
      onClose={onClose}
      placement="bottom-start"
      aria-label="Git Branches"
      className={styles.popup}
    >
      <RepositoryBar />
      <div className={styles.search}>
        <SearchField
          data-autofocus
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(0);
          }}
          placeholder="Search branches and actions"
          aria-label="Search branches and actions"
          variant="bare"
          onKeyDown={onKeyDown}
        />
        <IconButton icon="git-fetch" title="Fetch" size="small" action="vcs.fetch" />
      </div>
      <div ref={listRef} style={{ height }} className={styles.listWrap}>
        <List
          items={rows}
          getKey={(r) => r.key}
          isSection={isSection}
          renderSection={(r) => <span className={styles.section}>{r.type === "section" ? r.label : ""}</span>}
          activeIndex={activeIndex}
          onActiveChange={setActive}
          onActivate={(_r, i) => activate(i)}
          focusable={false}
          hoverSelects
          rowHeight={rowHeight}
          aria-label="Branches"
          className={styles.list}
          empty={<span className={styles.empty}>{loaded ? "No matching branches" : "Loading…"}</span>}
          renderItem={(r) => <BranchRowView row={r} />}
        />
      </div>
      {menuFor && (
        <Popup
          open
          anchor={menuFor.el}
          placement="right-start"
          offset={2}
          role="presentation"
          autoFocus={false}
          onClose={() => setMenuFor(null)}
          className={styles.menuPopup}
        >
          <MenuList
            items={menuFor.items}
            onDone={() => setMenuFor(null)}
            onCloseLevel={() => setMenuFor(null)}
            aria-label={menuFor.label}
          />
        </Popup>
      )}
    </Popup>
  );
}

/** Repository switcher (several repositories): branches, log and push act on the selected one. */
function RepositoryBar() {
  const roots = useVcs((s) => s.roots);
  const repo = useVcs((s) => s.repo);
  if (roots.length < 2) return null;
  return (
    <div className={styles.repos} role="group" aria-label="Repository">
      {roots.map((r) => (
        <button
          key={r}
          type="button"
          className={clsx(styles.repoButton, r === repo && styles.repoSelected)}
          aria-pressed={r === repo}
          title={r}
          onClick={() => void selectRepo(r).then(() => loadBranches().catch(() => undefined))}
        >
          {repoName(r)}
        </button>
      ))}
    </div>
  );
}

function BranchRowView({ row }: { row: BranchRow }) {
  if (row.type === "action") {
    const keys = shortcutLabel(row.action.id);
    return (
      <span className={styles.row} data-row-key={row.key}>
        <Icon name={row.action.icon ?? "more"} size={14} className={styles.rowIcon} />
        <HighlightedText className={styles.label} text={row.action.label} indices={row.matches} tone="accent" />
        {keys && <span className={styles.keys}>{keys}</span>}
      </span>
    );
  }
  if (row.type === "tag") {
    return (
      <span className={styles.row} data-row-key={row.key}>
        <Icon name="tag" size={14} className={styles.rowIcon} />
        <HighlightedText
          className={clsx(styles.label, styles.branchName)}
          text={row.tag}
          indices={row.matches}
          tone="accent"
        />
        <Icon name="chevron-right" size={10} className={styles.chevron} />
      </span>
    );
  }
  if (row.type !== "branch") return null;
  const b = row.branch;
  return (
    <span className={styles.row} data-row-key={row.key}>
      {b.current ? (
        <Icon name="current-branch" size={14} className={clsx(styles.rowIcon, styles.currentIcon)} />
      ) : (
        // Like IDEA: favorites show a star; others show an empty star on hover. Click toggles.
        <button
          type="button"
          className={clsx(styles.star, row.favorite && styles.starOn)}
          aria-label={row.favorite ? "Remove from Favorites" : "Add to Favorites"}
          aria-pressed={row.favorite}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavoriteBranch(b);
          }}
        >
          <Icon name={row.favorite ? "star" : "star-outline"} size={14} className={styles.starIcon} />
          {!row.favorite && <Icon name="branch" size={14} className={styles.branchIcon} />}
        </button>
      )}
      <HighlightedText
        className={clsx(styles.label, styles.branchName, b.current && styles.current)}
        text={b.name}
        indices={row.matches}
        tone="accent"
      />
      {b.current && <span className={styles.tag}>current</span>}
      {(b.ahead > 0 || b.behind > 0) && (
        <span className={styles.syncSmall}>
          {b.ahead > 0 && `↑${b.ahead}`}
          {b.behind > 0 && ` ↓${b.behind}`}
        </span>
      )}
      {!b.remote && b.upstream && <span className={styles.upstream}>{b.upstream}</span>}
      <Icon name="chevron-right" size={10} className={styles.chevron} />
    </span>
  );
}
