/** Promise-based modal prompts (exit confirmation, unsaved changes). */
import { useState } from "react";
import { create } from "zustand";
import { useT } from "@/platform/i18n";
import { Checkbox, Dialog, type MessageIconKind } from "@/ui";

export interface PromptButton {
  id: string;
  label: string;
  primary?: boolean;
}

export interface PromptRequest {
  title: string;
  body: string;
  /** Declaration order (IDEA `createActions`); the dialog orders them per platform. A Cancel button (id `cancel`) is added unless present. */
  buttons: PromptButton[];
  checkbox?: string;
  /** Defaults to `question`. */
  icon?: MessageIconKind;
}

export interface PromptResult {
  button: string;
  checked: boolean;
}

export type Ask = (request: PromptRequest) => Promise<PromptResult>;

interface PromptState {
  current: (PromptRequest & { resolve: (r: PromptResult) => void }) | null;
}

export const usePrompt = create<PromptState>(() => ({ current: null }));

/** Shows a prompt; a prompt already open is cancelled first. */
export const ask: Ask = (request) => {
  usePrompt.getState().current?.resolve({ button: "cancel", checked: false });
  return new Promise((resolve) => {
    usePrompt.setState({
      current: {
        ...request,
        resolve: (r) => {
          usePrompt.setState({ current: null });
          resolve(r);
        },
      },
    });
  });
};

export function PromptOverlay() {
  const current = usePrompt((s) => s.current);
  if (!current) return null;
  // Keyed so the checkbox state resets per prompt.
  return <PromptDialog key={current.title + current.body} request={current} />;
}

function PromptDialog({ request }: { request: NonNullable<PromptState["current"]> }) {
  const t = useT();
  const [checked, setChecked] = useState(false);
  const done = (button: string) => request.resolve({ button, checked });
  return (
    <Dialog
      open
      onClose={() => done("cancel")}
      title={request.title}
      icon={request.icon ?? "question"}
      width={520}
      footerStart={request.checkbox && <Checkbox checked={checked} onChange={setChecked} label={request.checkbox} />}
      buttons={[
        ...request.buttons.map((b) => ({
          label: b.label,
          role: b.primary ? ("default" as const) : b.id === "cancel" ? ("cancel" as const) : ("extra" as const),
          onClick: () => done(b.id),
        })),
        ...(request.buttons.some((b) => b.id === "cancel")
          ? []
          : [{ label: t("common.cancel"), role: "cancel" as const }]),
      ]}
    >
      {request.body}
    </Dialog>
  );
}
