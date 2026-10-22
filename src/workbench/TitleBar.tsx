import { useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useActions } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { BarButton, Icon, IconButton, Menu, type MenuItem } from "@/ui";
import { useContributions, type TitleItemContribution } from "./contributions";
import { ErrorBoundary } from "./ErrorBoundary";
import { MainMenu } from "./MainMenu";
import { WindowControls } from "./WindowControls";
import { usePlatform } from "@/platform/platformInfo";
import { projectInitials } from "./projectColor";
import styles from "./TitleBar.module.css";

export function orderTitleItems(items: Iterable<TitleItemContribution>) {
  const all = [...items];
  return {
    left: all.filter((i) => i.align === "left").sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
    right: all.filter((i) => i.align === "right").sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
  };
}

function TitleItem({ item }: { item: TitleItemContribution }) {
  const C = item.component;
  return (
    <div className={styles.item} data-title-item={item.id}>
      <ErrorBoundary name={`title item ${item.id}`}>
        <C />
      </ErrorBoundary>
    </div>
  );
}

function ProjectButton() {
  const name = useProject((s) => s.project?.name);
  const root = useProject((s) => s.project?.root);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const actions = useActions((s) => s.actions);
  const items = useMemo<MenuItem[]>(() => {
    const list: MenuItem[] = [{ kind: "action", action: "file.openProject", label: "Open…" }];
    if (actions.has("welcome.recentProjects")) list.push({ kind: "action", action: "welcome.recentProjects" });
    list.push({ kind: "separator" }, { kind: "action", action: "file.closeProject" });
    return list;
  }, [actions]);
  const label = name ?? "OpenIDEA";
  return (
    <>
      <BarButton
        ref={ref}
        variant="title"
        className={styles.widget}
        tooltip={root}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {projectInitials(label)}
        </span>
        <span className={styles.widgetText}>{label}</span>
        <Icon name="chevron-down" size={12} className={styles.chevron} />
      </BarButton>
      <Menu open={open} onClose={() => setOpen(false)} anchor={ref} items={items} aria-label="Project" />
    </>
  );
}

const VCS_FALLBACK_ACTIONS = ["vcs.clone", "vcs.localHistory", "vcs.showLog"];

/** "Version Control ▾" shown while no VCS widget is contributed (project without a repository). */
function VcsFallback() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const actions = useActions((s) => s.actions);
  const items = useMemo<MenuItem[]>(
    () => VCS_FALLBACK_ACTIONS.filter((id) => actions.has(id)).map((action) => ({ kind: "action", action })),
    [actions],
  );
  if (!items.length) return null;
  return (
    <>
      <BarButton
        ref={ref}
        variant="title"
        className={styles.widget}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.widgetText}>Version Control</span>
        <Icon name="chevron-down" size={12} className={styles.chevron} />
      </BarButton>
      <Menu open={open} onClose={() => setOpen(false)} anchor={ref} items={items} aria-label="Version Control" />
    </>
  );
}

/**
 * 40px main toolbar. macOS: native traffic lights overlay its left edge.
 * Windows: the window is frameless, so the bar carries IDEA's main menu (☰) and
 * the caption buttons. `dialog`: a dialog window's bar (Settings), close button only.
 */
export function TitleBar({
  minimal = false,
  bare = false,
  dialog = false,
  title,
}: {
  minimal?: boolean;
  bare?: boolean;
  dialog?: boolean;
  title?: string;
}) {
  const overlay = usePlatform((s) => s.overlayTitleBar);
  const frameless = usePlatform((s) => s.framelessTitleBar);
  const map = useContributions((s) => s.titleItems);
  const { left, right } = useMemo(() => orderTitleItems(map.values()), [map]);
  const [menuExpanded, setMenuExpanded] = useState(false);
  const className = clsx(styles.bar, overlay && styles.overlay, frameless && styles.frameless);
  if (bare)
    return (
      <header className={className} data-tauri-drag-region data-titlebar="bare">
        {frameless && (
          <>
            <div className={styles.drag} data-tauri-drag-region />
            <WindowControls />
          </>
        )}
      </header>
    );
  return (
    <header className={clsx(className, minimal && styles.minimal)} data-tauri-drag-region>
      {frameless && !minimal && <MainMenu onExpandedChange={setMenuExpanded} />}
      {title && (
        <span className={styles.windowTitle} data-tauri-drag-region>
          {title}
        </span>
      )}
      {!minimal && !menuExpanded && (
        <>
          <ProjectButton />
          {left.length > 0 ? left.map((i) => <TitleItem key={i.id} item={i} />) : <VcsFallback />}
        </>
      )}
      <div className={styles.drag} data-tauri-drag-region />
      {!minimal && (
        <>
          {right.map((i) => (
            <TitleItem key={i.id} item={i} />
          ))}
          <div className={styles.tools}>
            <IconButton
              icon="search"
              action="navigate.searchEverywhere"
              title="Search Everywhere"
              shortcut={shortcutLabel("navigate.searchEverywhere") ?? "⇧⇧"}
              iconSize={18}
              className={styles.tool}
            />
            <IconButton icon="settings" action="file.settings" title="Settings" iconSize={18} className={styles.tool} />
          </div>
        </>
      )}
      {frameless && <WindowControls dialog={dialog} />}
    </header>
  );
}
