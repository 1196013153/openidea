/** Dialog stack of the analysis feature and the shared "Specify Scope" fields. */
import { Fragment, type ReactNode } from "react";
import { create } from "zustand";
import { isTauri } from "@/platform/ipc";
import { Button, Input, T } from "@/ui";
import { SCOPE_LABELS, currentFile, type ScopeChoice, type ScopeKind } from "./scope";
import styles from "./Analysis.module.css";

interface Entry {
  id: number;
  render: (close: () => void) => ReactNode;
}

const useDialogs = create<{ stack: Entry[] }>(() => ({ stack: [] }));
let seq = 0;

/** Shows a dialog; `render` receives the function that closes it. */
export function openDialog(render: (close: () => void) => ReactNode): () => void {
  const id = ++seq;
  const close = () => useDialogs.setState((s) => ({ stack: s.stack.filter((e) => e.id !== id) }));
  useDialogs.setState((s) => ({ stack: [...s.stack, { id, render }] }));
  return close;
}

export function AnalysisDialogHost() {
  const stack = useDialogs((s) => s.stack);
  return (
    <>
      {stack.map((e) => (
        <Fragment key={e.id}>
          {e.render(() => useDialogs.setState((s) => ({ stack: s.stack.filter((x) => x.id !== e.id) })))}
        </Fragment>
      ))}
    </>
  );
}

async function browseDirectory(initial: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, defaultPath: initial || undefined });
  return typeof picked === "string" ? picked : null;
}

const KINDS: ScopeKind[] = ["project", "directory", "file", "changed"];

/** IDEA's "Specify Scope" radio group. */
export function ScopeFields({
  value,
  onChange,
  name,
}: {
  value: ScopeChoice;
  onChange: (v: ScopeChoice) => void;
  name: string;
}) {
  const file = currentFile();
  return (
    <fieldset className={styles.scope}>
      <legend className={styles.fieldLabel}>
        <T>Scope</T>
      </legend>
      {KINDS.map((kind) => (
        <label key={kind} className={styles.radioRow}>
          <input
            type="radio"
            name={name}
            checked={value.kind === kind}
            disabled={kind === "file" && !file}
            onChange={() => onChange({ ...value, kind })}
          />
          <span>{kind === "file" && file ? `File '${file.split("/").pop()}'` : SCOPE_LABELS[kind]}</span>
        </label>
      ))}
      {value.kind === "directory" && (
        <div className={styles.dirRow}>
          <Input
            aria-label="Directory"
            value={value.directory}
            onChange={(e) => onChange({ ...value, directory: e.target.value })}
            className={styles.grow}
          />
          <Button
            onClick={() => void browseDirectory(value.directory).then((d) => d && onChange({ ...value, directory: d }))}
          >
            <T>Browse…</T>
          </Button>
        </div>
      )}
    </fieldset>
  );
}
