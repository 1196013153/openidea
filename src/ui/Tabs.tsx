/**
 * Tab strip with the design's accent underline. Roving focus (←/→, Home/End),
 * closable tabs (button, middle click, Delete), horizontal wheel scrolling and
 * an overflow dropdown listing every tab when they don't fit.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./icons";
import { IconButton } from "./Button";
import { Menu, type MenuItem } from "./Menu";
import { tooltipAttrs } from "./Tooltip";
import { T } from "./T";
import styles from "./Tabs.module.css";
import { tx } from "@/platform/i18n";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Plain text used by the overflow menu and type-ahead when `label` isn't a string. */
  text?: string;
  icon?: IconName | (string & {});
  closable?: boolean;
  /** Unsaved changes marker. */
  modified?: boolean;
  /** CSS colour for the label (VCS status etc.), e.g. `var(--vcs-modified)`. */
  color?: string;
  italic?: boolean;
  tooltip?: string;
  /** Trailing content (counts, badges). */
  trailing?: ReactNode;
}

/**
 * Drag & drop of tabs. Strips sharing a `type` (a custom MIME type such as
 * `application/x-openidea-editor-tab`) accept each other's tabs; `onDrop`
 * receives the dragged tab's payload and the insertion index in this strip.
 */
export interface TabsDnd {
  type: string;
  payload: (id: string) => string;
  onDrop: (payload: string, index: number) => void;
}

/** Insertion index for a drop at `x` given the tabs' horizontal extents. Exported for tests. */
export function dropIndex(x: number, rects: ReadonlyArray<{ left: number; width: number }>): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (x < r.left + r.width / 2) return i;
  }
  return rects.length;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onContextMenu?: (id: string, e: MouseEvent) => void;
  /** `editor`: 30px with separators (editor tabs); `compact`: 28px plain (popups, tool window sub-tabs). */
  variant?: "editor" | "compact";
  /** Content after the tabs (breadcrumbs, actions). */
  trailing?: ReactNode;
  className?: string;
  "aria-label"?: string;
  /** Tabpanel id prefix for `aria-controls`. */
  panelIdPrefix?: string;
  /** Enables drag & drop reordering (and moving between strips of the same type). */
  dnd?: TabsDnd;
}

export function Tabs({
  items,
  activeId,
  onSelect,
  onClose,
  onContextMenu,
  variant = "editor",
  trailing,
  className,
  panelIdPrefix,
  dnd,
  ...aria
}: TabsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [overflow, setOverflow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const accepts = (e: DragEvent) => !!dnd && [...e.dataTransfer.types].includes(dnd.type);
  const indexAt = (x: number) =>
    dropIndex(
      x,
      items.map((it) => {
        const r = tabRefs.current.get(it.id)?.parentElement?.getBoundingClientRect();
        return { left: r?.left ?? 0, width: r?.width ?? 0 };
      }),
    );
  const dropHandlers = dnd
    ? {
        onDragOver: (e: DragEvent<HTMLDivElement>) => {
          if (!accepts(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const i = indexAt(e.clientX);
          if (i !== drop) setDrop(i);
        },
        onDragLeave: (e: DragEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
        },
        onDrop: (e: DragEvent<HTMLDivElement>) => {
          if (!accepts(e)) return;
          e.preventDefault();
          const payload = e.dataTransfer.getData(dnd.type);
          const i = indexAt(e.clientX);
          setDrop(null);
          if (payload) dnd.onDrop(payload, i);
        },
      }
    : {};

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length]);

  useEffect(() => {
    // The whole tab (label + close button) into view, without scrolling any outer container.
    const tab = activeId ? tabRefs.current.get(activeId)?.parentElement : null;
    const scroller = scrollRef.current;
    if (tab && scroller) revealHorizontally(scroller, tab);
  }, [activeId]);

  const focusTab = (index: number) => {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    onSelect(item.id);
    tabRefs.current.get(item.id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, index: number, item: TabItem) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowRight":
        focusTab(index + 1);
        break;
      case "ArrowLeft":
        focusTab(index - 1);
        break;
      case "Home":
        focusTab(0);
        break;
      case "End":
        focusTab(items.length - 1);
        break;
      case "Delete":
      case "Backspace":
        if (onClose && item.closable !== false) onClose(item.id);
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const menuItems: MenuItem[] = items.map((t) => ({
    id: t.id,
    label: tx(t.text ?? (typeof t.label === "string" ? t.label : t.id)),
    icon: t.icon,
    checked: t.id === activeId ? true : undefined,
    run: () => onSelect(t.id),
  }));

  return (
    <div className={clsx(styles.strip, styles[variant], className)} {...dropHandlers}>
      <div
        ref={scrollRef}
        role="tablist"
        aria-label={aria["aria-label"]}
        className={styles.scroller}
        onWheel={(e) => {
          const el = scrollRef.current;
          if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
        }}
      >
        {items.map((item, index) => {
          const selected = item.id === activeId;
          const closable = !!onClose && item.closable !== false;
          return (
            <div
              key={item.id}
              className={clsx(
                styles.tab,
                selected && styles.selected,
                closable && styles.closable,
                dragging === item.id && styles.dragging,
                drop === index && styles.dropBefore,
                drop === items.length && index === items.length - 1 && styles.dropAfter,
              )}
              draggable={!!dnd}
              onDragStart={
                dnd
                  ? (e) => {
                      e.dataTransfer.setData(dnd.type, dnd.payload(item.id));
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(item.id);
                    }
                  : undefined
              }
              onDragEnd={dnd ? () => (setDragging(null), setDrop(null)) : undefined}
              onMouseDown={(e) => {
                if (e.button === 1 && closable) {
                  e.preventDefault();
                  onClose!(item.id);
                }
              }}
              onContextMenu={onContextMenu ? (e) => onContextMenu(item.id, e) : undefined}
            >
              <button
                ref={(el) => {
                  if (el) tabRefs.current.set(item.id, el);
                  else tabRefs.current.delete(item.id);
                }}
                type="button"
                role="tab"
                id={panelIdPrefix ? `${panelIdPrefix}-tab-${item.id}` : undefined}
                aria-controls={panelIdPrefix ? `${panelIdPrefix}-panel-${item.id}` : undefined}
                aria-selected={selected}
                tabIndex={selected || (!activeId && index === 0) ? 0 : -1}
                className={styles.tabButton}
                style={item.color ? { color: item.color } : undefined}
                onClick={() => onSelect(item.id)}
                onKeyDown={(e) => onKeyDown(e, index, item)}
                {...tooltipAttrs(item.tooltip)}
              >
                {item.icon && <Icon name={item.icon} size={14} className={styles.tabIcon} />}
                <span className={clsx(styles.tabLabel, item.italic && styles.italic)}>
                  {typeof item.label === "string" ? <T>{item.label}</T> : item.label}
                </span>
                {item.trailing}
                {item.modified && !closable && <span className={styles.modified} aria-label="Modified" />}
              </button>
              {closable && (
                <span className={styles.closeSlot}>
                  {item.modified && <span className={styles.modified} aria-label="Modified" />}
                  <IconButton
                    icon="close"
                    title="Close Tab"
                    size="small"
                    iconSize={11}
                    tabIndex={-1}
                    className={styles.close}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose!(item.id);
                    }}
                  />
                </span>
              )}
            </div>
          );
        })}
      </div>
      {overflow && (
        <>
          <IconButton
            ref={moreRef}
            icon="chevron-down"
            title="Show Hidden Tabs"
            size="small"
            iconSize={10}
            className={styles.more}
            onClick={() => setMenuOpen((v) => !v)}
          />
          <Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchor={moreRef}
            items={menuItems}
            placement="bottom-end"
            aria-label="Tabs"
          />
        </>
      )}
      {trailing && <div className={styles.trailing}>{trailing}</div>}
    </div>
  );
}

/** Scrolls `scroller` horizontally just enough to show all of `child`. */
export function revealHorizontally(scroller: HTMLElement, child: HTMLElement) {
  const s = scroller.getBoundingClientRect();
  const c = child.getBoundingClientRect();
  if (c.left < s.left) scroller.scrollLeft -= s.left - c.left;
  else if (c.right > s.right) scroller.scrollLeft += Math.min(c.right - s.right, c.left - s.left);
}
