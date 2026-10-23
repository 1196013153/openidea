/**
 * Settings › Version Control › Confirmation: files created in the IDE are
 * added to Git (ask / silently / never); tracked files deleted in the IDE have
 * the deletion staged (`git rm`), with the same three choices.
 */
import { useState } from "react";
import { onFileOperation, type FileOperation } from "@/platform/fileOps";
import { call, commands, isTauri } from "@/platform/ipc";
import { loadSettings } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { Checkbox, Dialog } from "@/ui";
import { openDialog } from "./dialogs";
import { effectiveKind, relTo, stripSlash } from "./model";
import { runOp } from "./ops";
import { refreshNow, useVcs } from "./store";

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

/** Status paths affected by `paths` (a deleted folder covers its content). */
function matching(paths: readonly string[], kind: "untracked" | "deleted"): string[] {
  const out = new Set<string>();
  for (const f of useVcs.getState().status) {
    const p = stripSlash(f.path);
    if (effectiveKind(f) !== kind || f.staged) continue;
    for (const q of paths) {
      if (p === q || p.startsWith(q + "/")) out.add(p);
      // Inside an untracked folder git reports only the folder: add just the new path.
      else if (q.startsWith(p + "/")) out.add(q);
    }
  }
  return [...out];
}

function ask(op: FileOperation["kind"], files: string[]): Promise<{ ok: boolean; remember: boolean }> {
  const root = useVcs.getState().root ?? "";
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <ConfirmDialog op={op} files={files} root={root} onDone={(r) => (close(), resolve(r))} />
    ));
  });
}

function ConfirmDialog({
  op,
  files,
  root,
  onDone,
}: {
  op: FileOperation["kind"];
  files: string[];
  root: string;
  onDone: (r: { ok: boolean; remember: boolean }) => void;
}) {
  const [remember, setRemember] = useState(false);
  const add = op === "created";
  const n = files.length;
  const what = n === 1 ? "file" : `${n} files`;
  return (
    <Dialog
      open
      title={add ? "Add File to Git" : "Remove File from Git"}
      icon="question"
      onClose={() => onDone({ ok: false, remember: false })}
      width={480}
      footerStart={<Checkbox checked={remember} onChange={setRemember} label="Don't ask again" />}
      buttons={[
        {
          label: add ? "Add" : "Remove",
          role: "default",
          autoFocus: true,
          onClick: () => onDone({ ok: true, remember }),
        },
        { label: "Cancel", role: "cancel", onClick: () => onDone({ ok: false, remember }) },
      ]}
    >
      <>
        {add
          ? `Do you want to add the following ${what} to Git?`
          : `Do you want to remove the following ${what} from Git?`}
        {"\n"}
        {files
          .slice(0, 10)
          .map((f) => relTo(root, f))
          .join("\n")}
        {n > 10 ? "\n…" : ""}
      </>
    </Dialog>
  );
}

async function handle(op: FileOperation) {
  const vcs = useVcs.getState();
  if (!vcs.available || !vcs.root || !isTauri()) return;
  const conf = workflowSettings().vcs.confirmation;
  const mode = op.kind === "created" ? conf.onCreate : conf.onDelete;
  if (mode === "never") return;
  const paths = op.paths.map(stripSlash).filter((p) => inside(vcs.root!, p));
  if (!paths.length) return;
  await refreshNow();
  const files = matching(paths, op.kind === "created" ? "untracked" : "deleted");
  if (!files.length) return;
  if (mode === "ask") {
    const { ok, remember } = await ask(op.kind, files);
    if (remember) {
      const key = op.kind === "created" ? "vcs.confirmation.onCreate" : "vcs.confirmation.onDelete";
      try {
        await call(commands.settingsSet("global", key, JSON.stringify(ok ? "silently" : "never")));
        await loadSettings();
      } catch {
        // keep asking
      }
    }
    if (!ok) return;
  }
  const n = files.length;
  await runOp(
    op.kind === "created"
      ? `Add ${n} file${n === 1 ? "" : "s"} to Git`
      : `Remove ${n} file${n === 1 ? "" : "s"} from Git`,
    () => call(commands.vcsStage(files)),
  );
}

export function installFileConfirmations(): () => void {
  return onFileOperation((op) => void handle(op));
}
