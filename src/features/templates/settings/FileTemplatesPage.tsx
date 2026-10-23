/** Settings › Editor › File Templates. */
import { useState } from "react";
import clsx from "clsx";
import { Button, Checkbox, Icon, IconButton, Input, Select, T } from "@/ui";
import type { FileTemplate, NameStyle } from "../files/model";
import {
  isBuiltinFileTemplate,
  isModifiedFileTemplate,
  removeFileTemplate,
  resetFileTemplate,
  saveFileTemplate,
  useFileTemplates,
} from "../files/store";
import styles from "./Settings.module.css";

const NAME_STYLES: Array<{ value: NameStyle; label: string }> = [
  { value: "asis", label: "As typed" },
  { value: "snake", label: "snake_case" },
  { value: "pascal", label: "PascalCase" },
  { value: "kebab", label: "kebab-case" },
];

export function FileTemplatesPage() {
  const templates = useFileTemplates((s) => s.templates);
  useFileTemplates((s) => s.custom);
  const [selectedId, setSelectedId] = useState<string | null>(templates[0]?.id ?? null);
  const selected = templates.find((t) => t.id === selectedId) ?? null;

  const add = () => {
    const t: FileTemplate = {
      id: `user.${Date.now().toString(36)}`,
      name: "New Template",
      icon: "file",
      extension: "txt",
      nameStyle: "asis",
      kinds: [{ id: "default", label: "Default", body: "$END$\n" }],
    };
    saveFileTemplate(t);
    setSelectedId(t.id);
  };

  return (
    <div className={styles.page}>
      <div className={styles.split}>
        <div className={styles.side}>
          <div className={styles.toolbar}>
            <IconButton icon="plus" size="small" title="Add Template" onClick={add} />
            <IconButton
              icon="minus"
              size="small"
              title="Remove Template"
              disabled={!selected}
              onClick={() => {
                if (!selected) return;
                removeFileTemplate(selected.id);
                setSelectedId(null);
              }}
            />
          </div>
          <div className={styles.items} role="listbox" aria-label="File templates">
            {templates.map((t) => (
              <div
                key={t.id}
                role="option"
                aria-selected={t.id === selectedId}
                className={clsx(
                  styles.item,
                  t.id === selectedId && styles.itemSelected,
                  t.enabled === false && styles.disabledItem,
                )}
                onClick={() => setSelectedId(t.id)}
              >
                <Checkbox
                  checked={t.enabled !== false}
                  onChange={(v) => saveFileTemplate({ ...t, enabled: v })}
                  aria-label={`Enable ${t.name}`}
                />
                <Icon name={t.icon} size={14} />
                <span className={clsx(isModifiedFileTemplate(t.id) && styles.modified)}>{t.name}</span>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.editor}>
          {selected ? (
            <FileTemplateEditor key={selected.id} template={selected} />
          ) : (
            <div className={styles.empty}>
              <T>Select a template to edit it</T>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileTemplateEditor({ template: t }: { template: FileTemplate }) {
  const [kindIdx, setKindIdx] = useState(0);
  const kind = t.kinds[Math.min(kindIdx, t.kinds.length - 1)]!;
  const update = (patch: Partial<FileTemplate>) => saveFileTemplate({ ...t, ...patch });
  const updateKind = (patch: Partial<typeof kind>) =>
    update({ kinds: t.kinds.map((k) => (k.id === kind.id ? { ...k, ...patch } : k)) });

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>
          <T>Name</T>
        </span>
        <Input
          className={styles.grow}
          value={t.name}
          onChange={(e) => update({ name: e.target.value })}
          aria-label="Template name"
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>
          <T>Extension</T>
        </span>
        <Input
          mono
          value={t.extension}
          onChange={(e) => update({ extension: e.target.value.replace(/^\./, "").trim() })}
          aria-label="Extension"
          placeholder="none"
        />
        <span className={styles.label}>
          <T>File name</T>
        </span>
        <Select
          value={t.nameStyle}
          options={NAME_STYLES}
          onChange={(v) => update({ nameStyle: v })}
          aria-label="File name style"
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>
          <T>Kinds</T>
        </span>
        <div className={clsx(styles.tabs, styles.grow)} role="tablist" aria-label="Kinds">
          {t.kinds.map((k, i) => (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={k.id === kind.id}
              className={clsx(styles.tab, k.id === kind.id && styles.tabActive)}
              onClick={() => setKindIdx(i)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <IconButton
          icon="plus"
          size="small"
          title="Add Kind"
          onClick={() => {
            update({
              kinds: [...t.kinds, { id: `kind${Date.now().toString(36)}`, label: "New kind", body: "$END$\n" }],
            });
            setKindIdx(t.kinds.length);
          }}
        />
        <IconButton
          icon="minus"
          size="small"
          title="Remove Kind"
          disabled={t.kinds.length < 2}
          onClick={() => {
            update({ kinds: t.kinds.filter((k) => k.id !== kind.id) });
            setKindIdx(0);
          }}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>
          <T>Kind label</T>
        </span>
        <Input
          className={styles.grow}
          value={kind.label}
          onChange={(e) => updateKind({ label: e.target.value })}
          aria-label="Kind label"
        />
      </div>
      <textarea
        className={styles.body}
        value={kind.body}
        spellCheck={false}
        aria-label="Template body"
        onChange={(e) => updateKind({ body: e.target.value })}
      />
      <div className={styles.hint}>
        Variables: <code>$NAME$</code> <code>$PACKAGE$</code> <code>$FILE_NAME$</code> <code>$PROJECT_NAME$</code>{" "}
        <code>$USER$</code> <code>$DATE$</code> <code>$TIME$</code> <code>$YEAR$</code>; <code>$END$</code> places the
        caret. A line with <code>$PACKAGE$</code> is omitted (with one following blank line) when there is no package.
      </div>
      {isBuiltinFileTemplate(t.id) && isModifiedFileTemplate(t.id) && (
        <div className={styles.buttons}>
          <Button size="small" onClick={() => resetFileTemplate(t.id)}>
            <T>Restore Default</T>
          </Button>
        </div>
      )}
    </>
  );
}
