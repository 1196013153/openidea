/** Imperative prompt dialogs of the Services view, rendered by one overlay. */
import { Fragment, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Dialog, Input } from "@/ui";
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

function PromptDialog(props: {
  title: string;
  label: string;
  placeholder: string;
  onDone: (v: string | null) => void;
}) {
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
        <Input
          data-autofocus
          mono
          aria-label={props.label}
          placeholder={props.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </form>
    </Dialog>
  );
}
