/**
 * Add Agent: agents of the ACP Registry this machine can run, with Install / Update /
 * Remove. Installs run in the background with progress; closing the dialog cancels one.
 */
import { useEffect, useMemo, useState } from "react";
import type { AgentRegistry, RegistryAgent, RequestId } from "@/bindings";
import { isCancelled, nextRequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { Badge, Button, Dialog, ProgressBar, SearchField, Spinner, T } from "@/ui";
import {
  DISTRIBUTION_LABEL,
  afterInstall,
  afterRemove,
  matchesQuery,
  rowActions,
  tauriRegistry,
  type RegistryBackend,
} from "./registry";
import styles from "./AddAgent.module.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Job {
  id: string;
  request: RequestId;
  fraction: number | null;
  message: string;
}

export function AddAgentDialog({
  onClose,
  onChanged,
  backend = tauriRegistry,
}: {
  onClose: () => void;
  /** An agent was installed, updated or removed (the agent list changed). */
  onChanged?: () => void;
  backend?: RegistryBackend;
}) {
  const [registry, setRegistry] = useState<AgentRegistry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const request = nextRequestId();
    let live = true;
    backend
      .list(request)
      .then((r) => live && setRegistry(r))
      .catch((e: unknown) => live && !isCancelled(e) && setLoadError(errorText(e)));
    return () => {
      live = false;
      backend.cancel(request);
    };
  }, [backend]);

  const agents = useMemo(() => (registry?.agents ?? []).filter((a) => matchesQuery(a, query)), [registry, query]);
  const busy = job != null || removing != null;

  const setError = (id: string, error: string | null) =>
    setErrors((all) => {
      const { [id]: _, ...rest } = all;
      return error ? { ...rest, [id]: error } : rest;
    });

  const install = (agent: RegistryAgent) => {
    const request = nextRequestId();
    setError(agent.id, null);
    setJob({ id: agent.id, request, fraction: null, message: tx`Installing ${agent.name} ${agent.version}…` });
    backend
      .install(agent.id, request, (e) =>
        setJob((j) =>
          j && j.request === request
            ? e.type === "progress"
              ? { ...j, fraction: e.fraction, message: e.message }
              : { ...j, message: e.text }
            : j,
        ),
      )
      .then(() => {
        setRegistry((r) => r && { ...r, agents: afterInstall(r.agents, agent.id) });
        onChanged?.();
      })
      .catch((e: unknown) => !isCancelled(e) && setError(agent.id, errorText(e)))
      .finally(() => setJob(null));
  };

  const remove = (agent: RegistryAgent) => {
    setError(agent.id, null);
    setRemoving(agent.id);
    backend
      .remove(agent.id)
      .then(() => {
        setRegistry((r) => r && { ...r, agents: afterRemove(r.agents, agent.id) });
        onChanged?.();
      })
      .catch((e: unknown) => setError(agent.id, errorText(e)))
      .finally(() => setRemoving(null));
  };

  const close = () => {
    if (job) backend.cancel(job.request);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Add Agent"
      aria-label="Add Agent"
      width={620}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <div className={styles.body}>
        <SearchField
          autoFocus
          value={query}
          onChange={setQuery}
          placeholder={tx("Search the ACP Registry")}
          aria-label="Search agents"
          clearable
        />
        <p className={styles.notice}>
          <T>
            Agents in the ACP Registry are third-party software. They run on this computer with your permissions and can
            read and change your files. Install only agents you trust.
          </T>
        </p>
        {registry?.warning && (
          <p className={styles.warning} role="status">
            {registry.warning}
          </p>
        )}
        <div className={styles.list} aria-busy={!registry && !loadError}>
          {loadError ? (
            <p className={styles.error} role="alert">
              {tx`Cannot load the ACP Registry: ${loadError}`}
            </p>
          ) : !registry ? (
            <div className={styles.loading}>
              <Spinner size={14} />
              <T>Loading the ACP Registry…</T>
            </div>
          ) : agents.length === 0 ? (
            <p className={styles.empty}>
              {query ? <T>No agents match</T> : <T>The registry has no agents for this system</T>}
            </p>
          ) : (
            <ul className={styles.rows} aria-label="Registry agents">
              {agents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  job={job?.id === agent.id ? job : null}
                  removing={removing === agent.id}
                  disabled={busy}
                  error={errors[agent.id] ?? null}
                  onInstall={() => install(agent)}
                  onRemove={() => remove(agent)}
                  onCancel={() => job && backend.cancel(job.request)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function AgentRow({
  agent,
  job,
  removing,
  disabled,
  error,
  onInstall,
  onRemove,
  onCancel,
}: {
  agent: RegistryAgent;
  job: Job | null;
  removing: boolean;
  disabled: boolean;
  error: string | null;
  onInstall: () => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const actions = rowActions(agent);
  const titleId = `agent-${agent.id}`;
  return (
    <li className={styles.row} aria-labelledby={titleId}>
      <div className={styles.main}>
        <div className={styles.titleLine}>
          <span id={titleId} className={styles.name}>
            {agent.name}
          </span>
          <span className={styles.version}>{agent.installed ?? agent.version}</span>
          {agent.distribution && <Badge>{DISTRIBUTION_LABEL[agent.distribution]}</Badge>}
          {actions.update && <Badge tone="accent">{tx`${agent.version} available`}</Badge>}
          {agent.installed != null && !actions.update && <Badge tone="success">{tx("Installed")}</Badge>}
        </div>
        {agent.description && <p className={styles.description}>{agent.description}</p>}
        <div className={styles.meta}>
          {agent.authors.length > 0 && <span>{agent.authors.join(", ")}</span>}
          {agent.license && <span>{agent.license}</span>}
          {agent.repository && <ExternalLink url={agent.repository} label="Repository" />}
          {agent.website && agent.website !== agent.repository && <ExternalLink url={agent.website} label="Website" />}
        </div>
        {job && (
          <div className={styles.progress}>
            <ProgressBar value={job.fraction} aria-label={tx`Installing ${agent.name}`} />
            <span className={styles.progressText}>{job.message}</span>
          </div>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {job ? (
          <Button size="small" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <>
            {actions.install && (
              <Button size="small" variant="primary" disabled={disabled} onClick={onInstall}>
                Install
              </Button>
            )}
            {actions.update && (
              <Button size="small" variant="primary" disabled={disabled} onClick={onInstall}>
                Update
              </Button>
            )}
            {actions.remove && (
              <Button size="small" disabled={disabled} onClick={onRemove}>
                {removing ? "Removing…" : "Remove"}
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function ExternalLink({ url, label }: { url: string; label: string }) {
  return (
    <button type="button" className={styles.link} title={url} onClick={() => void openExternalUrl(url)}>
      <T>{label}</T>
    </button>
  );
}
