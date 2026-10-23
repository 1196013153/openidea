import { useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import type { RunConfig } from "@/platform/ipc";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, Select, type SelectOption, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import {
  KIND_OPTIONS,
  commandLine,
  configIcon,
  duplicateConfig,
  formatArgs,
  groupConfigs,
  hasErrors,
  newConfig,
  parseArgs,
  removeConfig,
  upsertConfig,
  userConfigs,
  validateConfig,
  type ConfigErrors,
} from "./configs";
import { saveUserConfigs, selectConfig, useRun } from "./store";
import styles from "./Run.module.css";

/**
 * Debug adapters with a real launch template (`debugger/launch.ts`, `debugger/java.ts`),
 * verified against small programs. Others (netcoredbg, dart, php-debug, …) only got
 * generic launch arguments and are left out until they have one; a configuration that
 * already names one keeps it.
 */
const ADAPTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "java-debug", label: "java-debug (Java)" },
  { id: "debugpy", label: "debugpy (Python)" },
  { id: "js-debug", label: "js-debug (Node.js / TypeScript)" },
  { id: "delve", label: "Delve (Go)" },
  { id: "codelldb", label: "CodeLLDB (Rust, C, C++)" },
  { id: "lldb-dap", label: "lldb-dap (C, C++, Swift)" },
];

interface EnvRow {
  key: string;
  value: string;
}

const envRows = (env: RunConfig["env"]): EnvRow[] => Object.entries(env).map(([key, value]) => ({ key, value }));

/** Env map from table rows; blank rows are ignored. */
export function envFromRows(rows: readonly EnvRow[]): { env: RunConfig["env"]; error?: string } {
  const env: RunConfig["env"] = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key && !r.value) continue;
    if (!key) return { env, error: "Environment variable names can't be empty" };
    if (key in env) return { env, error: `Duplicate environment variable: ${key}` };
    env[key] = r.value;
  }
  return { env };
}

export function EditConfigsOverlay() {
  const open = useRun((s) => s.editorOpen);
  if (!open) return null;
  return <EditConfigsDialog />;
}

function EditConfigsDialog() {
  const initialConfigs = useRun((s) => s.configs);
  const target = useRun((s) => s.editTarget ?? s.selectedId);
  const [draft, setDraft] = useState<RunConfig[]>(() => initialConfigs.map((c) => ({ ...c })));
  const [selected, setSelected] = useState<string | null>(() =>
    initialConfigs.some((c) => c.id === target) ? target : (initialConfigs[0]?.id ?? null),
  );
  const [argsText, setArgsText] = useState<Record<string, string>>({});
  const [envText, setEnvText] = useState<Record<string, EnvRow[]>>({});
  // "Modify Run Configuration…": the would-be configuration is saved on OK even when unedited.
  const [dirty, setDirty] = useState(() => useRun.getState().editDirty);
  const [saving, setSaving] = useState(false);

  const close = () => useRun.setState({ editorOpen: false, editTarget: null });
  const current = draft.find((c) => c.id === selected) ?? null;

  const errorsById = useMemo(() => {
    const out: Record<string, ConfigErrors> = {};
    for (const c of draft) {
      if (c.detected) continue;
      const e = validateConfig(c, draft);
      const rows = envText[c.id];
      const envError = rows ? envFromRows(rows).error : undefined;
      if (envError) e.env = envError;
      if (hasErrors(e)) out[c.id] = e;
    }
    return out;
  }, [draft, envText]);
  const invalid = Object.keys(errorsById).length > 0;
  const errors = (current && errorsById[current.id]) ?? {};

  const update = (patch: Partial<RunConfig>) => {
    if (!current) return;
    setDraft((d) => upsertConfig(d, { ...current, ...patch }));
    setDirty(true);
  };

  const add = () => {
    const c = newConfig(draft);
    setDraft((d) => [...d, c]);
    setSelected(c.id);
    setDirty(true);
  };

  const duplicate = () => {
    if (!current) return;
    const c = duplicateConfig(current, draft);
    setDraft((d) => [...d, c]);
    setSelected(c.id);
    setDirty(true);
  };

  const remove = () => {
    if (!current || current.detected) return;
    const index = draft.findIndex((c) => c.id === current.id);
    const next = removeConfig(draft, current.id);
    setDraft(next);
    setSelected(next[Math.min(index, next.length - 1)]?.id ?? null);
    setDirty(true);
  };

  const save = async (andClose: boolean) => {
    if (invalid) {
      const firstBad = Object.keys(errorsById)[0];
      if (firstBad) setSelected(firstBad);
      return;
    }
    setSaving(true);
    try {
      if (dirty) await saveUserConfigs(userConfigs(draft));
      setDirty(false);
      if (andClose) {
        if (selected) selectConfig(selected);
        close();
      }
    } catch (e) {
      notifications().notify({
        group: "run",
        level: "error",
        title: "Cannot save run configurations",
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const groups = groupConfigs(draft);
  const isOverride = current && !current.detected && !current.id.startsWith("user:");

  const kindOptions: SelectOption[] = KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
  if (current && !kindOptions.some((o) => o.value === current.kind))
    kindOptions.push({ value: current.kind, label: current.kind });

  const adapterOptions: SelectOption[] = [
    { value: "", label: "None" },
    ...ADAPTERS.map((a) => ({ value: a.id, label: a.label })),
  ];
  if (current?.debugAdapter && !ADAPTERS.some((a) => a.id === current.debugAdapter))
    adapterOptions.push({ value: current.debugAdapter, label: `${current.debugAdapter} (no launch template)` });

  const rows = current ? (envText[current.id] ?? envRows(current.env)) : [];
  const setRows = (next: EnvRow[]) => {
    if (!current) return;
    setEnvText((m) => ({ ...m, [current.id]: next }));
    const { env, error } = envFromRows(next);
    if (!error) update({ env });
    else setDirty(true);
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Run/Debug Configurations"
      width={820}
      className={styles.editDialog}
      footerStart={
        invalid && (
          <span className={styles.footerError}>
            <Icon name="error" size={13} /> <T>Fix the highlighted fields</T>
          </span>
        )
      }
      buttons={[
        { label: "OK", role: "default", disabled: saving || invalid, onClick: () => void save(true) },
        { label: "Cancel", role: "cancel" },
        { label: "Apply", disabled: !dirty || saving || invalid, onClick: () => void save(false) },
      ]}
    >
      <div className={styles.editBody}>
        <div className={styles.editSidebar}>
          <div className={styles.editToolbar} role="toolbar" aria-label="Configurations">
            <IconButton icon="plus" size="small" iconSize={14} title="Add New Configuration" onClick={add} />
            <IconButton
              icon="minus"
              size="small"
              iconSize={14}
              title={isOverride ? "Remove Override (restore detected)" : "Remove Configuration"}
              disabled={!current || current.detected}
              onClick={remove}
            />
            <IconButton
              icon="copy"
              size="small"
              iconSize={13}
              title="Copy Configuration"
              disabled={!current}
              onClick={duplicate}
            />
          </div>
          <div className={styles.editList} role="listbox" aria-label="Run configurations">
            {groups.map((g) => (
              <div key={g.kind} role="group" aria-label={g.label}>
                <div className={styles.editGroup}>{g.label}</div>
                {g.configs.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={c.id === selected}
                    className={clsx(styles.editItem, c.id === selected && styles.editItemSelected)}
                    onClick={() => setSelected(c.id)}
                    title={commandLine(c)}
                  >
                    <Icon name={configIcon(c)} size={13} className={styles.chooserIcon} />
                    <span className={styles.chooserName}>{c.name || "Unnamed"}</span>
                    {errorsById[c.id] && <Icon name="error" size={12} className={styles.failed} label="Invalid" />}
                    {!c.detected && <span className={styles.chooserMuted}>user</span>}
                  </button>
                ))}
              </div>
            ))}
            {draft.length === 0 && (
              <div className={styles.testEmpty}>
                <T>No configurations. Click + to add one.</T>
              </div>
            )}
          </div>
        </div>
        <div className={styles.editForm}>
          {current ? (
            <>
              {current.detected && (
                <div className={styles.notice}>
                  <T>Detected from the project. Changes are saved as a user configuration that overrides it.</T>
                </div>
              )}
              <Field label="Name" error={errors.name}>
                <Input
                  value={current.name}
                  invalid={!!errors.name}
                  aria-label="Name"
                  onChange={(e) => update({ name: e.target.value })}
                />
              </Field>
              <Field label="Kind">
                <Select
                  value={current.kind}
                  options={kindOptions}
                  onChange={(kind) => update({ kind })}
                  aria-label="Kind"
                />
              </Field>
              <Field label="Command" error={errors.command}>
                <Input
                  mono
                  value={current.command}
                  invalid={!!errors.command}
                  aria-label="Command"
                  placeholder="e.g. ./gradlew or cargo"
                  onChange={(e) => update({ command: e.target.value })}
                />
              </Field>
              <Field label="Arguments">
                <Input
                  mono
                  aria-label="Arguments"
                  value={argsText[current.id] ?? formatArgs(current.args)}
                  placeholder="Space separated; quote with ' or &quot;"
                  onChange={(e) => {
                    const text = e.target.value;
                    setArgsText((m) => ({ ...m, [current.id]: text }));
                    update({ args: parseArgs(text) });
                  }}
                />
              </Field>
              <Field label="Working directory" error={errors.cwd}>
                <Input
                  mono
                  aria-label="Working directory"
                  value={current.cwd ?? ""}
                  placeholder="Project root"
                  onChange={(e) => update({ cwd: e.target.value.trim() ? e.target.value : null })}
                />
              </Field>
              <Field label="Environment" error={errors.env} top>
                <div className={styles.envTable} role="table" aria-label="Environment variables">
                  {rows.map((r, i) => (
                    <div key={i} className={styles.envRow} role="row">
                      <Input
                        mono
                        aria-label={`Variable ${i + 1} name`}
                        value={r.key}
                        placeholder="NAME"
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                      />
                      <Input
                        mono
                        aria-label={`Variable ${i + 1} value`}
                        value={r.value}
                        placeholder="value"
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      />
                      <IconButton
                        icon="minus"
                        size="small"
                        iconSize={12}
                        title="Remove variable"
                        onClick={() => setRows(rows.filter((_, j) => j !== i))}
                      />
                    </div>
                  ))}
                  <Button
                    size="small"
                    variant="ghost"
                    icon="plus"
                    onClick={() => setRows([...rows, { key: "", value: "" }])}
                  >
                    <T>Add variable</T>
                  </Button>
                </div>
              </Field>
              <Field label="">
                <Checkbox
                  checked={current.isTest}
                  onChange={(isTest) => update({ isTest })}
                  label="Show results in the test runner"
                />
              </Field>
              <Field label="Debug adapter">
                <Select
                  value={current.debugAdapter ?? ""}
                  options={adapterOptions}
                  onChange={(v) => update({ debugAdapter: v || null })}
                  aria-label="Debug adapter"
                />
              </Field>
              <div className={styles.editPreview}>
                <span className={styles.chooserMuted}>
                  <T>Command line</T>
                </span>
                <code>{commandLine(current) || "—"}</code>
              </div>
            </>
          ) : (
            <div className={styles.testEmpty}>
              <T>Select a configuration</T>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function Field({ label, error, top, children }: { label: string; error?: string; top?: boolean; children: ReactNode }) {
  return (
    <div className={clsx(styles.field, top && styles.fieldTop)}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.fieldControl}>
        {children}
        {error && (
          <span className={styles.fieldError} role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
