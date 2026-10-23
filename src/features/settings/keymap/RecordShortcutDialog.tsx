/**
 * IDEA's "Keyboard Shortcut" dialog: records a first (and optional second)
 * stroke and lists conflicts live; OK with conflicts asks whether to remove the
 * other assignments (Remove / Leave / Cancel).
 */
import { useMemo, useState } from "react";
import { Checkbox, Dialog, Icon, Kbd, T } from "@/ui";
import type { Action } from "@/platform/actions";
import { normalizeBinding } from "@/platform/keymap";
import { ask } from "@/workbench/messages";
import { findConflicts, resolveBindings, type Conflict, type KeymapDraft } from "./model";
import { groupPath } from "./groups";
import { StrokeRecorder } from "./StrokeRecorder";
import styles from "./Keymap.module.css";

export interface RecordShortcutDialogProps {
  action: Pick<Action, "id" | "title" | "category" | "when">;
  actions: readonly Pick<Action, "id" | "title" | "category" | "when">[];
  draft: KeymapDraft;
  onCancel: () => void;
  /** `removeConflicts`: also unbind the conflicting assignments. */
  onSubmit: (binding: string, conflicts: Conflict[], removeConflicts: boolean) => void;
}

export function RecordShortcutDialog({ action, actions, draft, onCancel, onSubmit }: RecordShortcutDialogProps) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [useSecond, setUseSecond] = useState(false);

  const binding = first && useSecond ? (second ? `${first} ${second}` : "") : first;
  const conflicts = useMemo(
    () => (binding ? findConflicts(draft, binding, action.id, actions) : []),
    [binding, draft, action.id, actions],
  );
  const already = useMemo(
    () => !!binding && resolveBindings(draft, action.id).includes(normalizeBinding(binding)),
    [binding, draft, action.id],
  );

  const ok = async () => {
    if (!binding || already) return;
    if (!conflicts.length) return onSubmit(binding, conflicts, false);
    const { button } = await ask({
      title: "Warning",
      icon: "warning",
      body: (
        <>
          <T>The shortcut is already assigned to other actions. Do you want to remove other assignments?</T>
          <ConflictList conflicts={conflicts} />
        </>
      ),
      buttons: [
        { id: "remove", label: "Remove", primary: true },
        { id: "leave", label: "Leave" },
      ],
    });
    if (button !== "cancel") onSubmit(binding, conflicts, button === "remove");
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Keyboard Shortcut: ${action.title}`}
      width={440}
      buttons={[
        { label: "OK", role: "default", disabled: !binding || already, onClick: () => void ok() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.recordBody}>
        <div className={styles.recordRow}>
          <span className={styles.recordLabel}>
            <T>First stroke:</T>
          </span>
          <StrokeRecorder autoFocus value={first} onChange={setFirst} aria-label="First stroke" />
        </div>
        <div className={styles.recordRow}>
          <Checkbox checked={useSecond} onChange={setUseSecond} label="Second stroke:" />
          <StrokeRecorder
            value={second}
            onChange={setSecond}
            disabled={!useSecond}
            placeholder={useSecond ? "Press a shortcut" : ""}
            aria-label="Second stroke"
          />
        </div>
        <div className={styles.recordHint}>
          <T>Keys are recorded as pressed, including Tab and Esc. Use the buttons to finish.</T>
        </div>
        <div className={styles.conflictsLabel}>
          <T>Conflicts:</T>
        </div>
        <div className={styles.conflicts} aria-live="polite">
          {already && (
            <span className={styles.noConflicts}>
              <T>The action already has this shortcut</T>
            </span>
          )}
          {!already && binding && conflicts.length === 0 && (
            <span className={styles.noConflicts}>
              <T>No conflicts</T>
            </span>
          )}
          {!binding && (
            <span className={styles.noConflicts}>
              <T>Press a shortcut</T>
            </span>
          )}
          {conflicts.length > 0 && (
            <>
              <div className={styles.conflictTitle}>
                <Icon name="warning" size={14} className={styles.conflictIcon} />
                <span>
                  <Kbd binding={binding} /> <T>is already assigned to:</T>
                </span>
              </div>
              <ConflictList conflicts={conflicts} />
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ConflictList({ conflicts }: { conflicts: readonly Conflict[] }) {
  return (
    <ul className={styles.conflictList}>
      {conflicts.map((c) => (
        <li key={`${c.actionId}|${c.binding}`}>
          <span className={styles.conflictAction}>{c.title}</span>
          <span className={styles.conflictCategory}>
            ({groupPath({ id: c.actionId, category: c.category }).join(" | ")})
          </span>
          <span className={styles.spacer} />
          {c.kind === "prefix" && (
            <span className={styles.conflictCategory}>
              <T>chord prefix</T>
            </span>
          )}
          <Kbd binding={c.binding} />
        </li>
      ))}
    </ul>
  );
}
