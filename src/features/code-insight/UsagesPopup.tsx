/** ⌥⌘F7 Show Usages: popup list at the caret. */
import { useMemo, useState } from "react";
import { basename } from "@/platform/project";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { Icon, List, Popup, fileIconName } from "@/ui";
import { openLocation } from "./ipc";
import { usageCount, useUsagesPopup, type Usage } from "./usages";
import { UsagePreview } from "./UsagesView";
import styles from "./UsagesPopup.module.css";

const close = () => useUsagesPopup.setState({ open: false });

export function UsagesPopup() {
  const open = useUsagesPopup((s) => s.open);
  return open ? <UsagesPopupInner /> : null;
}

function UsagesPopupInner() {
  const { anchor, symbol, groups, note } = useUsagesPopup();
  const items = useMemo<Usage[]>(() => groups.flatMap((g) => g.usages), [groups]);
  const [active, setActive] = useState(0);
  const total = usageCount(groups);
  const pick = (u: Usage) => {
    close();
    openLocation(u.path, u.line, u.col);
  };
  const keys = shortcutLabel("find.usages");
  return (
    <Popup open anchor={anchor} onClose={close} aria-label="Usages" className={styles.popup}>
      <div className={styles.header}>
        <span className={styles.title}>
          Usages{symbol ? ` of ${symbol}` : ""} <span className={styles.count}>{total} found</span>
        </span>
        <button
          type="button"
          className={styles.link}
          onClick={() => {
            close();
            void executeAction("find.usages");
          }}
        >
          Open in Find Window{keys ? ` ${keys}` : ""}
        </button>
      </div>
      {note && <div className={styles.note}>{note}</div>}
      <div className={styles.body} style={{ height: Math.min(14, items.length) * 24 }}>
        <List
          items={items}
          getKey={(u) => `${u.path}:${u.line}:${u.col}`}
          activeIndex={Math.min(active, items.length - 1)}
          onActiveChange={setActive}
          hoverSelects
          aria-label="Usages"
          onActivate={pick}
          renderItem={(u) => (
            <div className={styles.row}>
              <Icon name={fileIconName(basename(u.path))} size={14} className={styles.icon} />
              <UsagePreview usage={u} />
              <span className={styles.spacer} />
              <span className={styles.where}>
                {basename(u.path)}:{u.line + 1}
              </span>
            </div>
          )}
        />
      </div>
    </Popup>
  );
}
