/**
 * Windows title bar: IDEA's main menu button. Clicking ☰ expands the menu bar
 * in place (File Edit View …) with File open; hovering another title switches
 * menus, ←/→ walk them, and closing the menu collapses the bar again. The
 * entries come from the same spec as the native menu (`menu_model`).
 */
import { useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { lookup, t } from "@/platform/i18n";
import { commands, type MenuNode } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { Icon, MenuList, Popup, type MenuItem } from "@/ui";
import menuStyles from "@/ui/Menu.module.css";
import { isDistractionFree } from "./distractionFree";
import styles from "./TitleBar.module.css";

function label(id: string, fallback: string): string {
  const key = `menu.${id}`;
  if (lookup(key) === undefined) return fallback;
  return t(key, { os: usePlatform.getState().os, distractionFree: isDistractionFree() ? "on" : "off" });
}

type Submenu = Extract<MenuNode, { kind: "submenu" }>;
const isSubmenu = (n: MenuNode): n is Submenu => n.kind === "submenu";

export function menuItems(nodes: MenuNode[]): MenuItem[] {
  return nodes.map((n): MenuItem => {
    switch (n.kind) {
      case "separator":
        return { kind: "separator" };
      case "placeholder":
        return { id: n.id, label: label(n.id, n.label), disabled: true };
      case "submenu":
        return { id: n.id, label: label(n.id, n.label), submenu: menuItems(n.children) };
      case "action":
        return { kind: "action", action: n.id, arg: n.arg ?? undefined, label: n.arg ? n.label : label(n.id, n.label) };
    }
  });
}

export function MainMenu({ onExpandedChange }: { onExpandedChange?: (expanded: boolean) => void }) {
  const [menus, setMenus] = useState<Submenu[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  // A press on another title closes the open menu first (outside click); keep the bar expanded.
  const pressedTitle = useRef(false);

  const expand = async () => {
    const model: MenuNode[] = await commands.menuModel().catch(() => []);
    const top = model.filter(isSubmenu);
    if (!top.length) return;
    setMenus(top);
    setOpen(0);
    onExpandedChange?.(true);
  };
  const collapse = () => {
    setOpen(null);
    setMenus(null);
    onExpandedChange?.(false);
  };
  const onMenuClose = (reason?: string) => {
    if (reason !== "outside") return collapse();
    setTimeout(() => {
      if (pressedTitle.current) pressedTitle.current = false;
      else collapse();
    });
  };
  const step = (delta: number) => {
    if (!menus || open === null) return;
    setOpen((open + delta + menus.length) % menus.length);
  };
  // ←/→ not used by the menu (top level, or a leaf item) move to the neighbouring menu.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    step(e.key === "ArrowRight" ? 1 : -1);
  };

  if (!menus)
    return (
      <button
        type="button"
        className={styles.mainMenuButton}
        aria-label={t("menu.mainMenu")}
        title={t("menu.mainMenu")}
        onClick={() => void expand()}
      >
        <Icon name="main-menu" size={16} />
      </button>
    );

  return (
    <div ref={setBar} role="menubar" className={styles.menuBar}>
      {menus.map((m, i) => (
        <button
          key={m.id}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === i}
          className={clsx(styles.menuTitle, open === i && styles.menuTitleOpen)}
          onPointerDown={() => {
            pressedTitle.current = true;
          }}
          onPointerEnter={() => {
            if (open !== null) setOpen(i);
          }}
          onClick={() => {
            pressedTitle.current = false;
            if (open === i) collapse();
            else setOpen(i);
          }}
        >
          {label(m.id, m.label)}
        </button>
      ))}
      {open !== null && menus[open] && bar?.children[open] && (
        <Popup
          key={menus[open].id}
          open
          anchor={bar.children[open]}
          placement="bottom-start"
          offset={2}
          role="presentation"
          autoFocus={false}
          onClose={onMenuClose}
          className={menuStyles.popup}
        >
          <div onKeyDown={onKeyDown}>
            <MenuList
              items={menuItems(menus[open].children)}
              onDone={collapse}
              aria-label={label(menus[open].id, menus[open].label)}
            />
          </div>
        </Popup>
      )}
    </div>
  );
}
