/**
 * Bookmark popups: the mnemonic chooser (⌥F3 / Ctrl+F11), the Bookmarks
 * popup (⌘F3: list + preview, Enter jumps) and the Edit Description dialog
 * (F2 / Rename).
 */
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { useProject } from "@/platform/project";
import { Dialog, Icon, Input, List, Popup, T, fileIconName, type DialogButton } from "@/ui";
import { CodePreview } from "../find/parts";
import { basename, openLocation, relPath } from "../common/open";
import {
  MNEMONICS,
  assignMnemonic,
  bookmarkAt,
  bookmarkLabel,
  describeBookmark,
  removeBookmarks,
  updateBookmarks,
  useBookmarkPopups,
  useBookmarks,
  type Bookmark,
} from "./store";
import styles from "./BookmarkPopups.module.css";

export function BookmarkPopupsOverlay() {
  const chooser = useBookmarkPopups((s) => s.chooser);
  const list = useBookmarkPopups((s) => s.list);
  const editing = useBookmarkPopups((s) => s.editing);
  return (
    <>
      {chooser && <MnemonicChooser key={`${chooser.path}:${chooser.line}`} />}
      {list && <BookmarksPopup />}
      {editing && <EditDescriptionDialog key={`${editing.path}:${editing.line}`} />}
    </>
  );
}

// --- mnemonic chooser ---------------------------------------------------------

const DIGITS = MNEMONICS.filter((m) => /\d/.test(m));
const LETTERS = MNEMONICS.filter((m) => /[A-Z]/.test(m));

function MnemonicChooser() {
  const target = useBookmarkPopups((s) => s.chooser)!;
  const items = useBookmarks((s) => s.items);
  const current = bookmarkAt(items, target.path, target.line);
  const assigned = useMemo(() => new Set(items.filter((b) => b.mnemonic && b !== current).map((b) => b.mnemonic!)), [items, current]);
  const [description, setDescription] = useState(current?.description ?? "");
  const close = () => useBookmarkPopups.setState({ chooser: null });
  const choose = (mnemonic: string) => {
    updateBookmarks((list) => assignMnemonic(list, target.path, target.line, target.text, mnemonic, description));
    close();
  };
  const title = !current ? "Add Mnemonic Bookmark" : current.mnemonic ? "Change Mnemonic" : "Assign Mnemonic";

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const inInput = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "Enter" && inInput) {
      e.preventDefault();
      if (current?.mnemonic) choose(current.mnemonic);
      else if (current) {
        updateBookmarks((list) => describeBookmark(list, target.path, target.line, description));
        close();
      }
      return;
    }
    if (inInput || e.key.length !== 1) return;
    const key = e.key.toUpperCase();
    if (!MNEMONICS.includes(key)) return;
    e.preventDefault();
    choose(key);
  };

  const button = (m: string) => (
    <button
      key={m}
      type="button"
      className={clsx(
        styles.key,
        m === current?.mnemonic && styles.keyCurrent,
        assigned.has(m) && styles.keyAssigned,
      )}
      aria-pressed={m === current?.mnemonic}
      onClick={() => choose(m)}
    >
      {m}
    </button>
  );

  return (
    <Popup
      open
      anchor={target.at ?? { x: window.innerWidth / 2 - 160, y: window.innerHeight / 3 }}
      placement="bottom-start"
      onClose={close}
      trapFocus
      aria-label={title}
    >
      <div className={styles.chooser} onKeyDown={onKeyDown}>
        <div className={styles.chooserTitle}>
          <T>{title}</T>
        </div>
        <div className={styles.grids}>
          <div className={styles.digits} data-autofocus tabIndex={-1}>
            {DIGITS.map(button)}
          </div>
          <div className={styles.letters}>{LETTERS.map(button)}</div>
        </div>
        <Input
          className={styles.description}
          value={description}
          placeholder="Description"
          aria-label="Bookmark description"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className={styles.legend}>
          <span className={clsx(styles.dot, styles.keyAssigned)} />
          <T>Assigned bookmark</T>
          <span className={styles.legendGap} />
          <span className={clsx(styles.dot, styles.keyCurrent)} />
          <T>Current bookmark</T>
        </div>
      </div>
    </Popup>
  );
}

// --- Bookmarks popup ------------------------------------------------------------

type Row = { kind: "file"; key: string; path: string } | { kind: "mark"; key: string; bookmark: Bookmark };

export function bookmarkRows(items: readonly Bookmark[]): Row[] {
  const rows: Row[] = [];
  let path: string | null = null;
  for (const b of items) {
    if (b.path !== path) {
      path = b.path;
      rows.push({ kind: "file", key: `f:${b.path}`, path: b.path });
    }
    rows.push({ kind: "mark", key: `b:${b.path}:${b.line}`, bookmark: b });
  }
  return rows;
}

const isFileRow = (r: Row) => r.kind === "file";

function BookmarksPopup() {
  const items = useBookmarks((s) => s.items);
  const root = useProject((s) => s.project?.root ?? null);
  const rows = useMemo(() => bookmarkRows(items), [items]);
  const [index, setIndex] = useState(() => rows.findIndex((r) => r.kind === "mark"));
  const active = Math.min(index, rows.length - 1);
  const row = rows[active];
  const selected = row?.kind === "mark" ? row.bookmark : null;
  const close = () => useBookmarkPopups.setState({ list: false });
  const jump = (b: Bookmark | null) => {
    if (!b) return;
    close();
    setTimeout(() => void openLocation(b.path, { line: b.line, col: 0 }), 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!selected) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      updateBookmarks((list) => removeBookmarks(list, (b) => b.path === selected.path && b.line === selected.line));
    } else if (e.key === "F2") {
      e.preventDefault();
      useBookmarkPopups.setState({ editing: { path: selected.path, line: selected.line } });
    }
  };

  return (
    <Dialog open onClose={close} width={820} title="Bookmarks" position="top" className={styles.listDialog}>
      <div className={styles.listBody} onKeyDown={onKeyDown}>
        <div className={styles.listPane}>
          <List<Row>
            items={rows}
            getKey={(r) => r.key}
            isSection={isFileRow}
            activeIndex={active}
            onActiveChange={setIndex}
            onActivate={(r, _i, e) => {
              if (e.type === "click" && (e as MouseEvent).detail < 2) return;
              if (r.kind === "mark") jump(r.bookmark);
            }}
            aria-label="Bookmarks"
            rowHeight={22}
            sectionHeight={24}
            empty={<span>{items.length ? null : <T>No bookmarks</T>}</span>}
            renderSection={(r) =>
              r.kind === "file" ? (
                <span className={styles.fileRow}>
                  <Icon name={fileIconName(basename(r.path))} size={14} />
                  <span className={styles.fileName}>{basename(r.path)}</span>
                  <span className={styles.dim}>{root ? relPath(r.path) : r.path}</span>
                </span>
              ) : null
            }
            renderItem={(r) =>
              r.kind === "mark" ? (
                <span className={styles.markRow}>
                  {r.bookmark.mnemonic ? (
                    <span className={styles.mnemonic}>{r.bookmark.mnemonic}</span>
                  ) : (
                    <Icon name="bookmark" size={14} />
                  )}
                  <span className={styles.markText}>{bookmarkLabel(r.bookmark) || "(empty line)"}</span>
                  <span className={styles.dim}>{r.bookmark.line + 1}</span>
                </span>
              ) : null
            }
          />
        </div>
        <div className={styles.previewPane}>
          <CodePreview path={selected?.path ?? null} line={selected?.line ?? 0} highlights={[]} />
        </div>
      </div>
    </Dialog>
  );
}

// --- Edit Description --------------------------------------------------------------

function EditDescriptionDialog() {
  const editing = useBookmarkPopups((s) => s.editing)!;
  const bookmark = useBookmarks((s) => bookmarkAt(s.items, editing.path, editing.line));
  const [text, setText] = useState(bookmark?.description ?? bookmark?.text ?? "");
  const close = () => useBookmarkPopups.setState({ editing: null });
  const save = () => {
    updateBookmarks((list) => describeBookmark(list, editing.path, editing.line, text));
    close();
  };
  const buttons: DialogButton[] = [
    { label: "Cancel", role: "cancel" },
    { label: "OK", role: "default", onClick: save },
  ];
  return (
    <Dialog open onClose={close} title="Edit Bookmark Description" width={420} buttons={buttons}>
      <Input
        data-autofocus
        value={text}
        aria-label="Description"
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
      />
    </Dialog>
  );
}
