/**
 * Messages (IDEA's `Messages` / `MessageDialogBuilder`): promise-based alert
 * dialogs for confirmations, questions and errors, shared by every feature.
 *
 *   const { button, checked } = await ask({ title, body, buttons, checkbox });
 *   if (await confirm({ title: "Delete", message: "Delete x?", ok: "Delete" })) …
 *   await showError("Cannot rebase", e.message);
 *
 * `MessagesHost` (rendered by `OverlayHost`) shows them, newest on top.
 */
import { useState, type ReactNode } from "react";
import { create } from "zustand";
import { t } from "@/platform/i18n";
import { Checkbox, Dialog, type DialogButton, type MessageIconKind } from "@/ui";

export interface MessageButton {
  id: string;
  label: string;
  /** The default button (Enter); at most one. */
  primary?: boolean;
}

export interface MessageRequest {
  title: string;
  body: ReactNode;
  /** Declaration order (IDEA `createActions`); the dialog orders them per platform. */
  buttons: MessageButton[];
  /** Adds a Cancel button (id `cancel`) unless one is declared. Default true. */
  cancel?: boolean;
  /** "Don't ask again" and similar, shown under the text. */
  checkbox?: string;
  /** Defaults to `question`. */
  icon?: MessageIconKind;
  width?: number;
}

export interface MessageResult {
  /** The chosen button's id; `cancel` for Escape and the Cancel button. */
  button: string;
  checked: boolean;
}

export type Ask = (request: MessageRequest) => Promise<MessageResult>;

interface Pending extends MessageRequest {
  id: number;
  resolve: (r: MessageResult) => void;
}

const useMessages = create<{ stack: Pending[] }>(() => ({ stack: [] }));
let seq = 0;

/** Shows a message dialog; resolves with the chosen button. */
export const ask: Ask = (request) =>
  new Promise((resolve) => {
    const id = ++seq;
    useMessages.setState((s) => ({
      stack: [
        ...s.stack,
        {
          ...request,
          id,
          resolve: (r) => {
            useMessages.setState((st) => ({ stack: st.stack.filter((m) => m.id !== id) }));
            resolve(r);
          },
        },
      ],
    }));
  });

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  /** Label of the default button. */
  ok: string;
  icon?: MessageIconKind;
  checkbox?: string;
}

/** OK / Cancel question; resolves `null` when cancelled, else the checkbox state. */
export async function confirmChecked(opts: ConfirmOptions): Promise<{ checked: boolean } | null> {
  const r = await ask({
    title: opts.title,
    body: opts.message,
    icon: opts.icon,
    checkbox: opts.checkbox,
    buttons: [{ id: "ok", label: opts.ok, primary: true }],
  });
  return r.button === "ok" ? { checked: r.checked } : null;
}

/** OK / Cancel question; resolves true for OK. */
export async function confirm(opts: Omit<ConfirmOptions, "checkbox">): Promise<boolean> {
  return (await confirmChecked(opts)) !== null;
}

/** IDEA's `Messages.showErrorDialog`: the error and an OK button. */
export async function showError(title: string, message: ReactNode): Promise<void> {
  await ask({
    title,
    body: message,
    icon: "error",
    cancel: false,
    buttons: [{ id: "ok", label: "OK", primary: true }],
  });
}

export function MessagesHost() {
  const stack = useMessages((s) => s.stack);
  return (
    <>
      {stack.map((m) => (
        <MessageDialog key={m.id} message={m} />
      ))}
    </>
  );
}

function MessageDialog({ message }: { message: Pending }) {
  const [checked, setChecked] = useState(false);
  const done = (button: string) => message.resolve({ button, checked });
  const declared: DialogButton[] = message.buttons.map((b) => ({
    label: b.label,
    role: b.primary ? "default" : b.id === "cancel" ? "cancel" : "extra",
    autoFocus: b.primary,
    onClick: () => done(b.id),
  }));
  const withCancel = message.cancel !== false && !message.buttons.some((b) => b.id === "cancel");
  return (
    <Dialog
      open
      onClose={() => done("cancel")}
      title={message.title}
      icon={message.icon ?? "question"}
      width={message.width ?? 460}
      footerStart={message.checkbox && <Checkbox checked={checked} onChange={setChecked} label={message.checkbox} />}
      buttons={withCancel ? [...declared, { label: t("common.cancel"), role: "cancel" }] : declared}
    >
      {message.body}
    </Dialog>
  );
}
