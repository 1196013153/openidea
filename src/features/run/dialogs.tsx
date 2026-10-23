/** Run feature dialogs: "Process is running" (rerun confirmation) and the External Tools `$Prompt$` input. */
import { useState } from "react";
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { loadSettings } from "@/platform/project";
import { Dialog, Input } from "@/ui";
import { confirmChecked } from "@/workbench/messages";
import styles from "./Run.module.css";

interface Pending {
  title: string;
  resolve: (value: string | null) => void;
}

const useRunDialog = create<{ pending: Pending | null }>(() => ({ pending: null }));

/** IDEA's "Process 'x' Is Running" dialog. Resolves true for Stop and Rerun. */
export async function confirmRerun(name: string): Promise<boolean> {
  const answer = await confirmChecked({
    title: `Process '${name}' Is Running`,
    message: `Do you want to stop the process '${name}' and run it again?`,
    ok: "Stop and Rerun",
    checkbox: "Do not ask again",
  });
  if (answer?.checked && isTauri()) {
    try {
      await call(commands.settingsSet("global", "run.confirmRerun", "false"));
      await loadSettings();
    } catch {
      /* keep asking */
    }
  }
  return answer !== null;
}

/** Asks for the value of `$Prompt$`; null when cancelled. */
export function promptValue(title: string): Promise<string | null> {
  return new Promise((resolve) => useRunDialog.setState({ pending: { title, resolve } }));
}

function close() {
  useRunDialog.setState({ pending: null });
}

function PromptDialog({ title, resolve }: { title: string; resolve: (v: string | null) => void }) {
  const [value, setValue] = useState("");
  const done = (v: string | null) => {
    close();
    resolve(v);
  };
  return (
    <Dialog
      open
      title={title}
      onClose={() => done(null)}
      width={420}
      buttons={[
        { label: "OK", role: "default", onClick: () => done(value) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.dialogBody}>
        <Input autoFocus aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
    </Dialog>
  );
}

export function RunDialogsOverlay() {
  const pending = useRunDialog((s) => s.pending);
  if (!pending) return null;
  return <PromptDialog title={pending.title} resolve={pending.resolve} />;
}
