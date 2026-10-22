/** Imperative prompt / confirm dialogs of the Services view, rendered by one overlay. */
import { Fragment, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Checkbox, Dialog, Input } from "@/ui";
import styles from "./Services.module.css";

interface Entry {
  id: number;
  node: ReactNode;
}

const useDialogs = create<{ stack: Entry[] }>(() => ({ stack: [] }));
let seq = 0;

function open(render: (close: () => void) => ReactNode): void {
  const id = ++seq;
  const close = () => useDialogs.setState((s) => ({ stack: s.stack.filter((e) => e.id !== id) }));
  useDialogs.setState((s) => ({ stack: [...s.stack, { id, node: render(close) }] }));
}

export function ServicesDialogHost() {
  const stack = useDialogs((s) => s.stack);
  return (
    <>
      {stack.map((e) => (
        <Fragment key={e.id}>{e.node}</Fragment>
      ))}
    </>
  );
}

export function promptText(title: string, label: string, placeholder: string): Promise<string | null> {
  return new Promise((resolve) =>
    open((close) => (
      <PromptDialog
        title={title}
        label={label}
        placeholder={placeholder}
        onDone={(v) => {
          close();
          resolve(v);
        }}
      />
    )),
  );
}

function PromptDialog(props: { title: string; label: string; placeholder: string; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState("");
  const ok = value.trim().length > 0;
  return (
    <Dialog
      open
      title={props.title}
      onClose={() => props.onDone(null)}
      width={420}
      buttons={[
        { label: "OK", role: "default", disabled: !ok, onClick: () => props.onDone(value.trim()) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) props.onDone(value.trim());
        }}
      >
        <label className={styles.fieldLabel}>{props.label}</label>
        <Input data-autofocus mono aria-label={props.label} placeholder={props.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
      </form>
    </Dialog>
  );
}

/** Confirmation with an optional checkbox; resolves `null` when cancelled, else the checkbox state. */
export function confirm(opts: { title: string; message: ReactNode; ok: string; checkbox?: string }): Promise<{ checked: boolean } | null> {
  return new Promise((resolve) =>
    open((close) => {
      const done = (r: { checked: boolean } | null) => {
        close();
        resolve(r);
      };
      return <ConfirmDialog {...opts} onDone={done} />;
    }),
  );
}

function ConfirmDialog(props: { title: string; message: ReactNode; ok: string; checkbox?: string; onDone: (r: { checked: boolean } | null) => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <Dialog
      open
      title={props.title}
      onClose={() => props.onDone(null)}
      width={440}
      buttons={[
        { label: props.ok, role: "default", autoFocus: true, onClick: () => props.onDone({ checked }) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <div className={styles.message}>{props.message}</div>
        {props.checkbox && <Checkbox checked={checked} onChange={setChecked} label={props.checkbox} />}
      </div>
    </Dialog>
  );
}
