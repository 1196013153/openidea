/** The Services tool window (⌘8): Docker tree on the left, log / inspect of the selection on the right. */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Channel } from "@tauri-apps/api/core";
import type { DockerAvailability, DockerLogLine, DockerObject } from "@/platform/ipc";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import {
  EmptyState,
  Icon,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tabs,
  Toggle,
  Tree,
  showContextMenu,
  type TreeRowState,
} from "@/ui";
import { childrenOf, findNode, nodeDetail, nodeIcon, nodeLabel, rootNodes, isRunning, type ServiceNode } from "./model";
import { canRemove, canStart, canStop, execShell, nodeMenu, pullPrompt, pruneMenu, remove, restart, start, stop } from "./ops";
import { cancelTask, errorMessage, refresh, useServices, watch } from "./store";
import styles from "./Services.module.css";

/** Status banner instead of the tree when docker cannot be used. */
function Unavailable({ availability }: { availability: DockerAvailability }) {
  if (availability.kind === "notInstalled")
    return (
      <EmptyState title="Docker is not installed">
        Install Docker Desktop, OrbStack, Colima or the Docker Engine and make sure <code>docker</code> is on PATH.
      </EmptyState>
    );
  if (availability.kind === "daemonDown")
    return (
      <EmptyState
        title="Docker is not running"
        actions={
          <IconButton icon="refresh" title="Retry" onClick={() => void refresh()} />
        }
      >
        <div>{availability.message}</div>
        <div className={styles.hint}>
          Start Docker{availability.context ? ` (context '${availability.context}')` : ""}; this view connects automatically.
        </div>
      </EmptyState>
    );
  return null;
}

function Row({ node, state }: { node: ServiceNode; state: TreeRowState }) {
  const detail = nodeDetail(node);
  const dim = node.kind === "container" && !isRunning(node.container);
  return (
    <span className={styles.row}>
      <Icon name={nodeIcon(node)} size={16} className={styles.icon} />
      <span className={clsx(styles.label, state.selected && styles.selectedLabel, dim && styles.dim)}>{nodeLabel(node)}</span>
      {detail && <span className={styles.detail}>{detail}</span>}
    </span>
  );
}

function Toolbar({ node }: { node: ServiceNode | null }) {
  const loading = useServices((s) => s.loading);
  const container = node?.kind === "container" ? node.container : null;
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Services actions">
      {loading ? <Spinner size={14} /> : <IconButton icon="refresh" size="small" iconSize={16} action="docker.refresh" />}
      <span className={styles.sep} />
      <IconButton icon="run" size="small" iconSize={16} title="Start" disabled={!canStart(node)} onClick={() => void start(node)} />
      <IconButton icon="stop" size="small" iconSize={16} title="Stop" disabled={!canStop(node)} onClick={() => void stop(node)} />
      <IconButton icon="rerun" size="small" iconSize={16} title="Restart" disabled={!node || !(node.kind === "container" || node.kind === "compose")} onClick={() => void restart(node)} />
      <IconButton icon="trash" size="small" iconSize={16} title="Delete" disabled={!canRemove(node)} onClick={() => void remove(node)} />
      <span className={styles.sep} />
      <IconButton icon="terminal" size="small" iconSize={16} title="Create Terminal" disabled={!container || !isRunning(container)} onClick={() => execShell(node)} />
      <IconButton icon="git-pull" size="small" iconSize={16} title="Pull Image…" onClick={() => void pullPrompt()} />
      <IconButton
        icon="trash"
        size="small"
        iconSize={16}
        title="Prune…"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          showContextMenu({ x: r.left, y: r.bottom + 2 }, pruneMenu());
        }}
      />
    </div>
  );
}

function TaskBanner() {
  const task = useServices((s) => s.task);
  if (!task) return null;
  return (
    <div className={styles.banner} role="status">
      <Spinner size={12} />
      <span className={styles.bannerTitle}>{task.title}</span>
      <span className={styles.bannerText}>{task.line}</span>
      <IconButton icon="close" size="small" title="Cancel" onClick={cancelTask} />
    </div>
  );
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex
const MAX_LINES = 5000;

/** Follows a container's log while shown. */
function LogView({ id, running }: { id: string; running: boolean }) {
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState(true);
  // A new stream (and buffer) per option set.
  return (
    <LogStream
      key={`${running}:${timestamps}`}
      id={id}
      running={running}
      timestamps={timestamps}
      setTimestamps={setTimestamps}
      wrap={wrap}
      setWrap={setWrap}
    />
  );
}

function LogStream(props: {
  id: string;
  running: boolean;
  timestamps: boolean;
  setTimestamps: (v: boolean) => void;
  wrap: boolean;
  setWrap: (v: boolean) => void;
}) {
  const { id, running, timestamps, setTimestamps, wrap, setWrap } = props;
  const [lines, setLines] = useState<DockerLogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const request = nextRequestId();
    const channel = new Channel<DockerLogLine>();
    let buffer: DockerLogLine[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const add = buffer;
      buffer = [];
      setLines((prev) => {
        const next = prev.concat(add);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    channel.onmessage = (line) => {
      buffer.push({ stderr: line.stderr, text: line.text.replace(ANSI, "") });
      frame ||= requestAnimationFrame(flush);
    };
    call(commands.dockerLogs(request, id, 1000, running, timestamps, channel)).catch((e) => {
      if (!isCancelled(e)) setError(errorMessage(e));
    });
    return () => {
      cancelAnimationFrame(frame);
      void commands.cancelRequest(request);
    };
  }, [id, running, timestamps]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className={styles.detailBody}>
      <div className={styles.subToolbar}>
        <Toggle checked={timestamps} onChange={setTimestamps} label="Timestamps" />
        <Toggle checked={wrap} onChange={setWrap} label="Soft-wrap" />
        <span className={styles.flex} />
        <IconButton icon="trash" size="small" title="Clear" onClick={() => setLines([])} />
      </div>
      <div
        ref={scroller}
        className={clsx(styles.log, wrap && styles.wrap)}
        role="log"
        aria-label="Container log"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.map((l, i) => (
          <div key={i} className={clsx(l.stderr && styles.stderr)}>
            {l.text || " "}
          </div>
        ))}
        {error && <div className={styles.stderr}>{error}</div>}
        {!lines.length && !error && <div className={styles.dim}>{running ? "Waiting for output…" : "No output"}</div>}
      </div>
    </div>
  );
}

function InspectView({ object, id }: { object: DockerObject; id: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    call(commands.dockerInspect(object, id))
      .then((t) => alive && setText(t))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [object, id]);
  return (
    <div className={styles.detailBody}>
      <pre className={clsx(styles.log, styles.json)} aria-label="Inspect">
        {error ?? text ?? "Loading…"}
      </pre>
    </div>
  );
}

function Detail({ node }: { node: ServiceNode | null }) {
  const tab = useServices((s) => s.detailTab);
  const snapshot = useServices((s) => s.snapshot);
  if (!node || node.kind === "docker" || node.kind === "group" || node.kind === "compose") {
    const a = snapshot?.availability;
    return (
      <EmptyState title={node?.kind === "compose" ? `Compose project '${node.project}'` : "Docker"}>
        {a?.kind === "ready" && (
          <div>
            Engine {a.serverVersion} · CLI {a.clientVersion}
            {a.context ? ` · context ${a.context}` : ""}
          </div>
        )}
        <div className={styles.hint}>Select a container, image, volume or network.</div>
      </EmptyState>
    );
  }
  const object: DockerObject = node.kind;
  const id = node.kind === "container" ? node.container.id : node.kind === "image" ? node.image.id : node.kind === "volume" ? node.volume.name : node.network.id;
  const showLog = node.kind === "container" && tab === "log";
  return (
    <div className={styles.detailPane}>
      <Tabs
        variant="compact"
        activeId={showLog ? "log" : "inspect"}
        onSelect={(t) => useServices.setState({ detailTab: t as "log" | "inspect" })}
        aria-label="Details"
        items={[...(node.kind === "container" ? [{ id: "log", label: "Log" }] : []), { id: "inspect", label: "Inspect" }]}
      />
      {showLog ? <LogView key={id} id={id} running={isRunning(node.container)} /> : <InspectView key={id} object={object} id={id} />}
    </div>
  );
}

export function ServicesView() {
  const snapshot = useServices((s) => s.snapshot);
  const error = useServices((s) => s.error);
  const selectedKey = useServices((s) => s.selectedKey);
  const expanded = useServices((s) => s.expanded);
  useEffect(() => watch(), []);

  const getChildren = useMemo(() => childrenOf(snapshot), [snapshot]);
  const roots = useMemo(() => rootNodes(), []);
  const node = useMemo(() => findNode(snapshot, selectedKey), [snapshot, selectedKey]);

  if (!snapshot)
    return <div className={styles.loading}>{error ?? <><Spinner size={14} /> Connecting to Docker…</>}</div>;

  const ready = snapshot.availability.kind === "ready";
  return (
    <div className={styles.view}>
      <Toolbar node={ready ? node : null} />
      <TaskBanner />
      {snapshot.errors.length > 0 && (
        <div className={clsx(styles.banner, styles.warning)}>
          <Icon name="warning" size={14} />
          <span className={styles.bannerText}>{snapshot.errors.join("; ")}</span>
        </div>
      )}
      {!ready ? (
        <Unavailable availability={snapshot.availability} />
      ) : (
        <SplitGroup orientation="horizontal" className={styles.split}>
          <SplitPanel defaultSize="40%" minSize="160px">
            <Tree<ServiceNode>
              roots={roots}
              getKey={(n) => n.key}
              getLabel={nodeLabel}
              getChildren={getChildren}
              isExpandable={(n) => !!getChildren(n)?.length}
              expanded={expanded}
              onExpandedChange={(next) => useServices.setState({ expanded: next })}
              selected={selectedKey ? new Set([selectedKey]) : new Set()}
              onSelectionChange={(_keys, lead) => useServices.setState({ selectedKey: lead?.key ?? null })}
              renderNode={(n, state) => <Row node={n} state={state} />}
              onActivate={(n) => {
                if (n.kind === "container") useServices.setState({ detailTab: "log" });
              }}
              onContextMenu={(n, _sel, e) => {
                if (!n) return;
                e.preventDefault();
                useServices.setState({ selectedKey: n.key });
                showContextMenu({ x: e.clientX, y: e.clientY }, nodeMenu(n));
              }}
              speedSearch
              aria-label="Services"
              className={styles.tree}
            />
          </SplitPanel>
          <SplitHandle />
          <SplitPanel minSize="200px">
            <Detail node={node} />
          </SplitPanel>
        </SplitGroup>
      )}
    </div>
  );
}
