/** Title bar branch widget (branch name + incoming / outgoing markers) + Branches popup. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import {
  BarButton,
  HighlightedText,
  Icon,
  List,
  listNavigate,
  MenuList,
  Popup,
  SearchField,
  firstSelectable,
} from "@/ui";
import { buildBranchRows, type BranchRow, type PopupAction } from "./branches";
import { branchMenu } from "./branchMenu";
import { recentBranches } from "./branchOps";
import { inProgress, operationTitle, type InProgress } from "./operations";
import { loadBranches, useVcs } from "./store";
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
  const open = useBranchesPopup((s) => s.open);
  const ref = useRef<HTMLButtonElement>(null);
  if (!available || !branch) return null;
  const op = branch.operation ? ` (${branch.operation})` : "";
  const sync = [
    branch.behind > 0 ? `${branch.behind} incoming` : "",
    branch.ahead > 0 ? `${branch.ahead} outgoing` : "",
  ].filter(Boolean);
  const tooltip =
    (branch.upstream
      ? `Git branch: ${headLabel(branch)}${op}\nTracking ${branch.upstream}`
      : `Git branch: ${headLabel(branch)}${op}`) + (sync.length ? `\n${sync.join(", ")} commits` : "");
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
        <span className={styles.name}>
          {inProgress(branch.operation) ? operationTitle(inProgress(branch.operation)!, branch.head) : headLabel(branch)}
        </span>
        {branch.operation && !inProgress(branch.operation) && <span className={styles.operation}>{branch.operation}</span>}
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
  const [menuFor, setMenuFor] = useState<{ row: Extract<BranchRow, { type: "branch" }>; el: HTMLElement } | null>(
    null,
  );
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void loadBranches().catch(() => undefined);
  }, []);

  const op = useVcs((s) => inProgress(s.branch?.operation));
  const conflicts = useVcs((s) => s.status.filter((f) => f.unstaged === "conflicted").length);
  const actions = useMemo(() => [...operationActions(op, conflicts), ...POPUP_ACTIONS], [op, conflicts]);
  const rows = useMemo(() => buildBranchRows(branches, recent, query, actions), [branches, recent, query, actions]);
  const isSection = (r: BranchRow) => r.type === "section";
  const activeIndex = rows[active] && !isSection(rows[active]!) ? active : firstSelectable(rows, isSection);

  const openMenu = (i: number) => {
    const row = rows[i];
    if (row?.type !== "branch") return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(row.key)}"]`);
    if (el) setMenuFor({ row, el: (el.closest('[role="option"]') as HTMLElement | null) ?? el });
  };

  const activate = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.type === "action") {
      onClose();
      void executeAction(row.action.id, row.action.arg);
    } else if (row.type === "branch") {
      openMenu(i);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      activate(activeIndex);
      return;
    }
    if (e.key === "ArrowRight" && rows[activeIndex]?.type === "branch") {
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
            items={branchMenu(menuFor.row.branch, current, () => {
              setMenuFor(null);
              onClose();
            })}
            onDone={() => setMenuFor(null)}
            onCloseLevel={() => setMenuFor(null)}
            aria-label={`Branch ${menuFor.row.branch.name}`}
          />
        </Popup>
      )}
    </Popup>
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
  if (row.type !== "branch") return null;
  const b = row.branch;
  return (
    <span className={styles.row} data-row-key={row.key}>
      <Icon name="branch" size={14} className={clsx(styles.rowIcon, b.current && styles.currentIcon)} />
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
