import { useEffect, type ReactNode } from "react";
import { create } from "zustand";
import { Dialog } from "@/ui";
import styles from "./ProjectView.module.css";

interface ConfirmRequest {
  title: string;
  message: ReactNode;
  okLabel: string;
  resolve: (ok: boolean) => void;
}

const useConfirm = create<{ request: ConfirmRequest | null }>(() => ({ request: null }));

/** Shows a modal Yes/Cancel dialog; resolves with the choice. */
export function confirmDialog(opts: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  useConfirm.getState().request?.resolve(false);
  return new Promise((resolve) => {
    useConfirm.setState({
      request: {
        ...opts,
        resolve: (ok) => {
          useConfirm.setState({ request: null });
          resolve(ok);
        },
      },
    });
  });
}

/** Overlay contribution rendering the pending confirmation. */
export function ConfirmDialogHost() {
  const request = useConfirm((s) => s.request);
  useEffect(() => () => useConfirm.getState().request?.resolve(false), []);
  if (!request) return null;
  return (
    <Dialog
      open
      title={request.title}
      onClose={() => request.resolve(false)}
      width={420}
      buttons={[
        { label: request.okLabel, role: "default", autoFocus: true, onClick: () => request.resolve(true) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.confirmBody}>{request.message}</div>
    </Dialog>
  );
}
