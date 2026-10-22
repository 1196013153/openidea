/** Run feature dialogs: "Process is running" (rerun confirmation) and the External Tools `$Prompt$` input. */
import { useState } from "react";
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { loadSettings } from "@/platform/project";
import { Checkbox, Dialog, Input } from "@/ui";
import styles from "./Run.module.css";

type Pending =
  | { kind: "rerun"; name: string; resolve: (ok: boolean) => void }
  | { kind: "prompt"; title: string; resolve: (value: string | null) => void };

const useRunDialog = create<{ pending: Pending | null }>(() => ({ pending: null }));

/** IDEA's "Process 'x' Is Running" dialog. Resolves true for Stop and Rerun. */
export function confirmRerun(name: string): Promise<boolean> {
  return new Promise((resolve) => useRunDialog.setState({ pending: { kind: "rerun", name, resolve } }));
}

/** Asks for the value of `$Prompt$`; null when cancelled. */
export function promptValue(title: string): Promise<string | null> {
  return new Promise((resolve) => useRunDialog.setState({ pending: { kind: "prompt", title, resolve } }));
}

function close() {
  useRunDialog.setState({ pending: null });
}

function RerunDialog({ name, resolve }: { name: string; resolve: (ok: boolean) => void }) {
  const [dontAsk, setDontAsk] = useState(false);
  const done = async (ok: boolean) => {
    close();
    if (ok && dontAsk && isTauri()) {
      try {
        await call(commands.settingsSet("global", "run.confirmRerun", "false"));
        await loadSettings();
      } catch {
        /* keep asking */
      }
    }
    resolve(ok);
  };
  return (
    <Dialog
      open
      title={`Process '${name}' Is Running`}
      onClose={() => void done(false)}
      width={440}
      footerStart={<Checkbox checked={dontAsk} onChange={setDontAsk} label="Do not ask again" />}
      buttons={[
        { label: "Stop and Rerun", role: "default", autoFocus: true, onClick: () => void done(true) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.dialogBody}>Do you want to stop the process '{name}' and run it again?</div>
    </Dialog>
  );
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
        <Input
          autoFocus
          aria-label="Value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

export function RunDialogsOverlay() {
  const pending = useRunDialog((s) => s.pending);
  if (!pending) return null;
  if (pending.kind === "rerun") return <RerunDialog name={pending.name} resolve={pending.resolve} />;
  return <PromptDialog title={pending.title} resolve={pending.resolve} />;
}
