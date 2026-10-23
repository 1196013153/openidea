/** "Compare with current": commits on either side of two branches. */
import { useEffect, useState } from "react";
import type { Commit } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { Dialog, List, Spinner, Tabs, T } from "@/ui";
import { openDialog } from "./dialogs";
import { formatTime } from "./model";
import { useVcs } from "./store";
import styles from "./common.module.css";

const LIMIT = 2000;

/** Commits reachable from `to` but not from `from` (git's `from..to`), computed by git, unbounded by any window. */
const commitsBetween = (from: string, to: string) =>
  call(
    commands.vcsLog({
      branch: null,
      path: null,
      author: null,
      text: null,
      range: `${from}..${to}`,
      skip: 0,
      limit: LIMIT,
    }),
  );

export function showCompareBranches(branch: string) {
  const current = useVcs.getState().branch?.head ?? "HEAD";
  openDialog((close) => <CompareDialog branch={branch} current={current} onClose={close} />);
}

function CompareDialog({ branch, current, onClose }: { branch: string; current: string; onClose: () => void }) {
  const [data, setData] = useState<{ incoming: Commit[]; outgoing: Commit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("incoming");
  useEffect(() => {
    let alive = true;
    Promise.all([commitsBetween("HEAD", branch), commitsBetween(branch, "HEAD")])
      .then(([incoming, outgoing]) => {
        if (alive) setData({ incoming, outgoing });
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [branch]);
  const list = data ? (tab === "incoming" ? data.incoming : data.outgoing) : [];
  return (
    <Dialog
      open
      title={`Compare ${current} with ${branch}`}
      onClose={onClose}
      width={640}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <Tabs
        variant="compact"
        activeId={tab}
        onSelect={setTab}
        aria-label="Direction"
        items={[
          {
            id: "incoming",
            label: `In ${branch}, not in ${current}`,
            trailing: data ? String(data.incoming.length) : undefined,
          },
          {
            id: "outgoing",
            label: `In ${current}, not in ${branch}`,
            trailing: data ? String(data.outgoing.length) : undefined,
          },
        ]}
      />
      <div style={{ height: 320, display: "flex", flexDirection: "column" }}>
        {error ? (
          <div className={styles.error} style={{ padding: 14 }}>
            {error}
          </div>
        ) : !data ? (
          <div className={styles.empty}>
            <Spinner size={14} />
          </div>
        ) : (
          <List
            items={list}
            getKey={(c) => c.id}
            rowHeight={22}
            aria-label="Commits"
            className={styles.grow}
            empty={
              <span>
                <T>No commits</T>
              </span>
            }
            onActivate={(c) => {
              onClose();
              void executeAction("vcs.showCommit", c.id);
            }}
            renderItem={(c) => (
              <span className={styles.commitRow} style={{ flex: 1, padding: 0 }}>
                <span className={styles.commitHash}>{c.shortId}</span>
                <span className={styles.commitSubject}>{c.summary}</span>
                <span className={styles.commitMeta}>{c.author}</span>
                <span className={styles.commitMeta}>{formatTime(c.timeMs)}</span>
              </span>
            )}
          />
        )}
      </div>
    </Dialog>
  );
}
