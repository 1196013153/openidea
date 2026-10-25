/** React popups for LSP editor features, rendered as a workbench overlay. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import {
  Button,
  Dialog,
  HighlightedText,
  Icon,
  Input,
  List,
  Popup,
  SymbolBadge,
  fileIconName,
  fuzzyMatch,
  T,
} from "@/ui";
import { basename, relativePath, useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import { closePopup, useLspPopup, type ListPopupItem, type LspPopup } from "./popupStore";
import { renderCode, renderMarkup } from "./markdown";
import { describeSummary } from "./workspaceEdit";
import { useUsagesStatus } from "./navigation";
import styles from "./Popups.module.css";

export function BulbIcon({ fix }: { fix?: boolean }) {
  return <Icon name="bulb" size={16} className={clsx(styles.bulb, fix && styles.bulbFix)} />;
}

function ItemIcon({ item }: { item: ListPopupItem }) {
  if (item.symbol) return <SymbolBadge kind={item.symbol} />;
  if (item.icon === "bulb" || item.icon === "bulb-fix") return <BulbIcon fix={item.icon === "bulb-fix"} />;
  if (item.icon) return <Icon name={item.icon} size={14} className={styles.itemIcon} />;
  return <span className={styles.iconSpacer} />;
}

function ListPopup({ popup }: { popup: Extract<LspPopup, { kind: "list" }> }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (!query) return popup.items.map((item) => ({ item, match: null as number[] | null }));
    return popup.items.map((item) => ({ item, match: fuzzyMatch(item.label, query) })).filter((r) => r.match !== null);
  }, [popup.items, query]);
  const firstEnabled = Math.max(
    0,
    filtered.findIndex((r) => !r.item.disabled),
  );
  const [active, setActive] = useState(firstEnabled);
  const activeIndex = Math.min(active, Math.max(0, filtered.length - 1));

  const activate = (item: ListPopupItem) => {
    if (item.disabled) return;
    closePopup();
    void item.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Backspace" && query) {
      setQuery(query.slice(0, -1));
      setActive(0);
      e.preventDefault();
    } else if (e.key.length === 1 && !(e.key === " " && !query)) {
      setQuery(query + e.key);
      setActive(0);
      e.preventDefault();
    }
  };

  const height = Math.min(12, Math.max(1, filtered.length)) * 24;
  // Rows are virtualized (absolutely positioned), so size the popup from the content.
  const width = useMemo(() => {
    const chars = Math.max(
      popup.title.length,
      ...popup.items.map(
        (i) => i.label.length + (i.preview?.length ?? 0) + (i.detail?.length ?? 0) + (i.shortcut?.length ?? 0),
      ),
    );
    return Math.min(720, Math.max(320, chars * 7 + 90));
  }, [popup]);
  return (
    <Popup
      open
      anchor={popup.anchor}
      onClose={closePopup}
      aria-label={popup.title}
      className={styles.listPopup}
      style={{ width }}
    >
      <div className={styles.listHeader}>
        <span className={styles.listTitle}>{popup.title}</span>
        {query && <span className={styles.query}>{query}</span>}
      </div>
      <div onKeyDown={onKeyDown} className={styles.listBody} style={{ height }}>
        <List
          items={filtered}
          getKey={(r) => r.item.id}
          activeIndex={activeIndex}
          onActiveChange={setActive}
          hoverSelects
          aria-label={popup.title}
          onActivate={(r) => activate(r.item)}
          empty={
            <span className={styles.empty}>
              <T>Nothing matches</T>
            </span>
          }
          renderItem={({ item, match }) => (
            <div
              className={clsx(styles.item, item.disabled && styles.disabled, item.emphasis && styles.emphasis)}
              title={item.disabled ?? undefined}
            >
              <ItemIcon item={item} />
              <HighlightedText className={styles.label} text={item.label} indices={match} tone="accent" />
              {item.preview && <span className={styles.preview}>{item.preview}</span>}
              <span className={styles.spacer} />
              {item.detail && <span className={styles.detail}>{item.detail}</span>}
              {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
            </div>
          )}
        />
      </div>
    </Popup>
  );
}

function RenamePopup({ popup }: { popup: Extract<LspPopup, { kind: "rename" }> }) {
  const [value, setValue] = useState(popup.initial);
  const ref = useRef<HTMLInputElement>(null);
  const suggestions = popup.suggestions ?? [];
  useEffect(() => {
    ref.current?.select();
  }, []);
  const submit = (name = value.trim()) => {
    closePopup();
    popup.onSubmit(name);
  };
  const pick = (delta: number) => {
    if (!suggestions.length) return false;
    const i = suggestions.indexOf(value.trim());
    const next = suggestions[(i + delta + suggestions.length) % suggestions.length]!;
    setValue(next);
    requestAnimationFrame(() => ref.current?.select());
    return true;
  };
  return (
    <Popup
      open
      anchor={popup.anchor}
      placement="bottom-start"
      onClose={closePopup}
      aria-label={popup.title}
      className={styles.renamePopup}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className={styles.renameLabel} htmlFor="lsp-rename-input">
          {popup.title}
        </label>
        <Input
          id="lsp-rename-input"
          ref={ref}
          mono
          data-autofocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && pick(e.key === "ArrowDown" ? 1 : -1))
              e.preventDefault();
          }}
          invalid={!value.trim()}
          aria-label="New name"
        />
        {suggestions.length > 1 && (
          <ul className={styles.renameSuggestions} aria-label="Suggested names">
            {suggestions.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className={clsx(styles.renameSuggestion, s === value.trim() && styles.renameSuggestionActive)}
                  onClick={() => submit(s)}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        )}
        {popup.note && <div className={styles.renameNote}>{popup.note}</div>}
        <div className={styles.renameHint}>{popup.hint ?? "↵ Rename · Esc Cancel"}</div>
      </form>
    </Popup>
  );
}

function DomContent({ build, className }: { build: () => HTMLElement; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const node = build();
    el.replaceChildren(node);
    return () => el.replaceChildren();
    // Built once per popup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={ref} className={className} />;
}

function DocPopup({ popup }: { popup: Extract<LspPopup, { kind: "doc" }> }) {
  const focusSeq = useLspPopup((s) => s.focusSeq);
  const scope = useRef<HTMLDivElement>(null);
  const opened = useRef(focusSeq);
  useEffect(() => {
    if (focusSeq !== opened.current) scope.current?.focus({ preventScroll: true });
  }, [focusSeq]);
  return (
    <Popup open anchor={popup.anchor} onClose={closePopup} aria-label="Documentation" className={styles.docPopup}>
      <div ref={scope} tabIndex={-1} className={clsx(popup.themeClasses, styles.docScope)}>
        <DomContent className={styles.docBody} build={() => renderMarkup(popup.markup, popup.language)} />
      </div>
    </Popup>
  );
}

function DefinitionPopup({ popup }: { popup: Extract<LspPopup, { kind: "definition" }> }) {
  const root = useProject((s) => s.project?.root ?? "");
  const { location } = popup;
  const open = () => {
    closePopup();
    void editorService().openFile(location.path, {
      selection: { line: location.range.start.line, col: location.range.start.col },
      focus: true,
    });
  };
  return (
    <Popup open anchor={popup.anchor} onClose={closePopup} aria-label="Definition" className={styles.defPopup}>
      <div className={styles.defHeader}>
        <Icon name={fileIconName(basename(location.path))} size={14} />
        <span className={styles.defFile}>{basename(location.path)}</span>
        <span className={styles.defPath}>
          {relativePath(root, location.path)}:{location.range.start.line + 1}
        </span>
        <span className={styles.spacer} />
        <Button size="small" variant="ghost" onClick={open}>
          <T>Open</T>
        </Button>
      </div>
      <div className={clsx(popup.themeClasses, styles.docScope)}>
        <DomContent className={styles.defBody} build={() => renderCode(popup.text, popup.language, "cm-lsp-code")} />
      </div>
    </Popup>
  );
}

function PreviewDialog({ popup }: { popup: Extract<LspPopup, { kind: "preview" }> }) {
  const root = useProject((s) => s.project?.root ?? "");
  const { summary } = popup;
  return (
    <Dialog
      open
      onClose={closePopup}
      title={popup.title}
      width={560}
      buttons={[
        {
          label: popup.confirmLabel,
          role: "default",
          autoFocus: true,
          onClick: () => {
            closePopup();
            popup.onConfirm();
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      {popup.warnings?.map((w) => (
        <div key={w} className={styles.previewWarning} role="note">
          <Icon name="warning" size={14} />
          <span>{w}</span>
        </div>
      ))}
      <div className={styles.previewSummary}>{describeSummary(summary)}</div>
      {popup.occurrences ? (
        <ul className={styles.previewList} aria-label="Occurrences">
          {popup.occurrences.map((o, i) => {
            const lead = o.text.length - o.text.trimStart().length;
            const text = o.text.trim();
            const from = Math.max(0, o.from - lead);
            const to = Math.max(from, Math.min(text.length, o.to - lead));
            return (
              <li key={i} className={styles.previewRow}>
                <span className={styles.previewLine}>{o.line + 1}</span>
                <span className={styles.previewCode}>
                  {text.slice(0, from)}
                  <mark className={styles.previewMatch}>{text.slice(from, to)}</mark>
                  {text.slice(to)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className={styles.previewList} aria-label="Changes">
          {summary.entries.map((e) => (
            <li key={e.path} className={styles.previewRow}>
              <Icon name={fileIconName(basename(e.path))} size={14} className={styles.itemIcon} />
              <span className={styles.previewName}>{basename(e.path)}</span>
              <span className={styles.previewPath}>{relativePath(root, e.path)}</span>
              <span className={styles.spacer} />
              {e.operation === "rename" && e.to && <span className={styles.previewOp}>→ {basename(e.to)}</span>}
              {e.operation && e.operation !== "rename" && <span className={styles.previewOp}>{e.operation}</span>}
              {e.edits > 0 && (
                <span className={styles.previewCount}>
                  {e.edits} {e.edits === 1 ? "occurrence" : "occurrences"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Status bar text while ⌘⇧F7 usages are highlighted ("3 usages of 'x' found…"). */
export function UsagesStatus() {
  const text = useUsagesStatus((s) => s.text);
  if (!text) return null;
  return (
    <span className={styles.statusMessage} role="status" title={text}>
      {text}
    </span>
  );
}

/** Overlay host: renders the current LSP popup, if any. */
export function LspPopups() {
  const popup = useLspPopup((s) => s.popup);
  const seq = useLspPopup((s) => s.seq);
  if (!popup) return null;
  switch (popup.kind) {
    case "list":
      return <ListPopup key={seq} popup={popup} />;
    case "rename":
      return <RenamePopup key={seq} popup={popup} />;
    case "doc":
      return <DocPopup key={seq} popup={popup} />;
    case "definition":
      return <DefinitionPopup key={seq} popup={popup} />;
    case "preview":
      return <PreviewDialog key={seq} popup={popup} />;
  }
}
