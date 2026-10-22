/**
 * IDEA's "Keyboard Shortcut" dialog: records a first (and optional second)
 * stroke and lists conflicts live; OK with conflicts asks whether to remove the
 * other assignments (Remove / Leave / Cancel).
 */
import { useMemo, useState } from "react";
import { Checkbox, Dialog, Icon, Kbd } from "@/ui";
import type { Action } from "@/platform/actions";
import { normalizeBinding } from "@/platform/keymap";
import { findConflicts, resolveBindings, type Conflict, type KeymapDraft } from "./model";
import { groupPath } from "./groups";
import { ConfirmDialog } from "./KeymapDialogs";
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

  const [asking, setAsking] = useState(false);
  const submit = (remove: boolean) => {
    if (binding) onSubmit(binding, conflicts, remove);
  };
  const ok = () => {
    if (!binding || already) return;
    if (conflicts.length) setAsking(true);
    else submit(false);
  };

  return (
    <>
      <Dialog
        open
        onClose={onCancel}
        title={`Keyboard Shortcut: ${action.title}`}
        width={440}
        buttons={[
          { label: "OK", role: "default", disabled: !binding || already, onClick: ok },
          { label: "Cancel", role: "cancel" },
        ]}
      >
        <div className={styles.recordBody}>
          <div className={styles.recordRow}>
            <span className={styles.recordLabel}>First stroke:</span>
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
            Keys are recorded as pressed, including Tab and Esc. Use the buttons to finish.
          </div>
          <div className={styles.conflictsLabel}>Conflicts:</div>
          <div className={styles.conflicts} aria-live="polite">
            {already && <span className={styles.noConflicts}>The action already has this shortcut</span>}
            {!already && binding && conflicts.length === 0 && <span className={styles.noConflicts}>No conflicts</span>}
            {!binding && <span className={styles.noConflicts}>Press a shortcut</span>}
            {conflicts.length > 0 && (
              <>
                <div className={styles.conflictTitle}>
                  <Icon name="warning" size={14} className={styles.conflictIcon} />
                  <span>
                    <Kbd binding={binding} /> is already assigned to:
                  </span>
                </div>
                <ConflictList conflicts={conflicts} />
              </>
            )}
          </div>
        </div>
      </Dialog>
      {asking && (
        <ConfirmDialog
          title="Warning"
          message="The shortcut is already assigned to other actions. Do you want to remove other assignments?"
          confirm="Remove"
          extra={{ label: "Leave", run: () => submit(false) }}
          onCancel={() => setAsking(false)}
          onConfirm={() => submit(true)}
        >
          <ConflictList conflicts={conflicts} />
        </ConfirmDialog>
      )}
    </>
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
          {c.kind === "prefix" && <span className={styles.conflictCategory}>chord prefix</span>}
          <Kbd binding={c.binding} />
        </li>
      ))}
    </ul>
  );
}
