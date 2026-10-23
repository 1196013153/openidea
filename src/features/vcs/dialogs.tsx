/** Imperative dialogs for VCS actions, rendered by one overlay contribution. */
import { Fragment, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Checkbox, Dialog, Input } from "@/ui";
import styles from "./common.module.css";

interface DialogEntry {
  id: number;
  render: (close: () => void) => ReactNode;
}

const useVcsDialogs = create<{ stack: DialogEntry[] }>(() => ({ stack: [] }));
let seq = 0;

/** Shows `render(close)` above the workbench; returns `close`. */
export function openDialog(render: (close: () => void) => ReactNode): () => void {
  const id = ++seq;
  const close = () => useVcsDialogs.setState((s) => ({ stack: s.stack.filter((e) => e.id !== id) }));
  useVcsDialogs.setState((s) => ({ stack: [...s.stack, { id, render }] }));
  return close;
}

export function VcsDialogHost() {
  const stack = useVcsDialogs((s) => s.stack);
  return (
    <>
      {stack.map((e) => (
        <Fragment key={e.id}>
          {e.render(() => useVcsDialogs.setState((s) => ({ stack: s.stack.filter((x) => x.id !== e.id) })))}
        </Fragment>
      ))}
    </>
  );
}

export interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  okLabel?: string;
  mono?: boolean;
  /** Returns an error message, or null when valid. */
  validate?: (value: string) => string | null;
  /** Optional checkbox below the field. */
  checkbox?: { label: string; initial: boolean };
}

export interface PromptResult {
  value: string;
  checked: boolean;
}

export function promptText(opts: PromptOptions): Promise<PromptResult | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <PromptDialog
        {...opts}
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function PromptDialog(props: PromptOptions & { onDone: (r: PromptResult | null) => void }) {
  const { title, label, initial = "", placeholder, okLabel = "OK", mono, validate, checkbox, onDone } = props;
  const [value, setValue] = useState(initial);
  const [checked, setChecked] = useState(checkbox?.initial ?? false);
  const [touched, setTouched] = useState(false);
  const error = validate ? validate(value) : value.trim() ? null : "Value must not be empty";
  const submit = () => {
    setTouched(true);
    if (!error) onDone({ value: value.trim(), checked });
  };
  return (
    <Dialog
      open
      title={title}
      onClose={() => onDone(null)}
      width={420}
      buttons={[
        { label: okLabel, role: "default", disabled: !!error, onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {label && <label className={styles.fieldLabel}>{label}</label>}
        <Input
          data-autofocus
          aria-label={label ?? title}
          value={value}
          mono={mono}
          placeholder={placeholder}
          invalid={touched && !!error}
          onChange={(e) => {
            setTouched(true);
            setValue(e.target.value);
          }}
        />
        {touched && error && value && <div className={styles.error}>{error}</div>}
        {checkbox && <Checkbox checked={checked} onChange={setChecked} label={checkbox.label} />}
      </form>
    </Dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  okLabel?: string;
  danger?: boolean;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const close = openDialog(() => {
      const done = (ok: boolean) => {
        close();
        resolve(ok);
      };
      return (
        <Dialog
          open
          title={opts.title}
          icon={opts.danger ? "warning" : "question"}
          onClose={() => done(false)}
          width={460}
          buttons={[
            { label: opts.okLabel ?? "OK", role: "default", autoFocus: true, onClick: () => done(true) },
            { label: "Cancel", role: "cancel" },
          ]}
        >
          {opts.message}
        </Dialog>
      );
    });
  });
}
