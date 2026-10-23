/** Data source (add / edit / test connection) and password dialogs. */
import { Fragment, useState } from "react";
import {
  call,
  commands,
  IpcError,
  type DataSource,
  type DbDriver,
  type DbSsh,
  type DbSshAuth,
  type DbSslMode,
} from "@/platform/ipc";
import { Button, Checkbox, Dialog, Input, Select, Tabs, lazyComponent, T } from "@/ui";
import { connectRemedy, fileSourceName, newSourceId, sshLabel } from "./model";
import { closeDialog, saveSource, useDatabase } from "./store";
import styles from "./Database.module.css";

const ObjectDialogs = lazyComponent(() => import("./ObjectDialogs").then((m) => m.ObjectDialogs));

const DRIVERS: Array<{ value: DbDriver; label: string }> = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL / MariaDB" },
  { value: "sqlite", label: "SQLite" },
];

const SSL: Array<{ value: DbSslMode; label: string }> = [
  { value: "prefer", label: "Prefer" },
  { value: "require", label: "Require" },
  { value: "disable", label: "Disable" },
];

const SSH_AUTH: Array<{ value: DbSshAuth; label: string }> = [
  { value: "openSsh", label: "OpenSSH config and authentication agent" },
  { value: "password", label: "Password" },
  { value: "keyPair", label: "Key pair" },
];

const blankSsh = (): DbSsh => ({
  enabled: false,
  host: "",
  port: null,
  user: "",
  auth: "openSsh",
  keyFile: "",
  saveSecret: true,
});

const parsePort = (v: string) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
};

function blank(): DataSource {
  return {
    id: newSourceId(),
    name: "",
    driver: "postgres",
    host: "localhost",
    port: null,
    database: "",
    user: "",
    file: null,
    ssl: "prefer",
    savePassword: true,
    readOnly: false,
  };
}

function SourceDialog({
  initial,
  preset,
  presetPassword,
}: {
  initial: DataSource | null;
  preset?: Partial<DataSource>;
  presetPassword?: string | null;
}) {
  const [s, setS] = useState<DataSource>(() => ({ ...blank(), ...preset, ...initial }));
  // `undefined`: unchanged (editing keeps the stored password).
  const [password, setPassword] = useState<string | undefined>(presetPassword ?? undefined);
  // Same convention for the SSH password / passphrase.
  const [sshSecret, setSshSecret] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<"general" | "ssh">("general");
  const [test, setTest] = useState<{ ok: boolean; text: string; trust?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<DataSource>) => setS((x) => ({ ...x, ...patch }));
  const ssh: DbSsh = { ...blankSsh(), ...s.ssh };
  const setSsh = (patch: Partial<DbSsh>) => setS((x) => ({ ...x, ssh: { ...blankSsh(), ...x.ssh, ...patch } }));
  const sqlite = s.driver === "sqlite";
  const name = s.name?.trim() || (sqlite ? fileSourceName(s.file ?? "") : `${s.database || s.user || "db"}@${s.host}`);
  const sshOn = !sqlite && !!ssh.enabled;
  const valid = sqlite ? !!s.file?.trim() : !!s.host?.trim() && (!sshOn || !!ssh.host?.trim());

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const v = await call(commands.dbTest({ ...s, name }, password ?? null, sshOn ? (sshSecret ?? null) : null));
      setTest({ ok: true, text: `Succeeded: ${v}` });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      const trust = e instanceof IpcError && connectRemedy(e.kind, e.message) === "trustHostKey";
      setTest({ ok: false, text, trust });
    } finally {
      setBusy(false);
    }
  };

  const trustAndRetry = async () => {
    await call(commands.dbTrustSshHost(s.id ?? ""));
    await runTest();
  };

  const save = async () => {
    setBusy(true);
    try {
      await saveSource(
        { ...s, name },
        sqlite ? undefined : password === undefined ? undefined : password || null,
        !sshOn || sshSecret === undefined || ssh.auth === "openSsh" ? undefined : sshSecret || null,
      );
      closeDialog();
    } catch (e) {
      setTest({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const file = await open({ multiple: false, directory: false, title: "SQLite Database File" });
    if (typeof file === "string") set({ file });
  };

  const browseKey = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const file = await open({ multiple: false, directory: false, title: "Private Key File" });
    if (typeof file === "string") setSsh({ keyFile: file });
  };

  return (
    <Dialog
      open
      onClose={closeDialog}
      title={initial ? `Data Source: ${initial.name}` : "New Data Source"}
      width={560}
      footerStart={
        <Button onClick={() => void runTest()} disabled={busy || !valid}>
          <T>Test Connection</T>
        </Button>
      }
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "OK", role: "default", disabled: busy || !valid, onClick: () => void save() },
      ]}
    >
      {!sqlite && (
        <Tabs
          variant="compact"
          className={styles.dialogTabs}
          activeId={tab}
          onSelect={(id) => setTab(id as "general" | "ssh")}
          aria-label="Data source settings"
          panelIdPrefix="db-source"
          items={[
            { id: "general", label: "General" },
            { id: "ssh", label: "SSH/SSL" },
          ]}
        />
      )}
      <div
        className={styles.form}
        role={sqlite ? undefined : "tabpanel"}
        id={sqlite ? undefined : `db-source-panel-${tab}`}
      >
        {sqlite || tab === "general" ? (
          <>
            <label className={styles.formLabel} htmlFor="db-name">
              <T>Name:</T>
            </label>
            <Input
              id="db-name"
              value={s.name ?? ""}
              placeholder={name}
              onChange={(e) => set({ name: e.target.value })}
            />
            <span className={styles.formLabel}>
              <T>Driver:</T>
            </span>
            <Select
              aria-label="Driver"
              value={s.driver ?? "postgres"}
              options={DRIVERS}
              onChange={(driver) => set({ driver })}
            />
            {sqlite ? (
              <>
                <label className={styles.formLabel} htmlFor="db-file">
                  <T>File:</T>
                </label>
                <div className={styles.formRow}>
                  <Input
                    id="db-file"
                    className={styles.fill}
                    value={s.file ?? ""}
                    placeholder="path/to/database.db (absolute or project-relative)"
                    onChange={(e) => set({ file: e.target.value || null })}
                  />
                  <Button onClick={() => void browse()}>
                    <T>Browse…</T>
                  </Button>
                </div>
              </>
            ) : (
              <>
                <label className={styles.formLabel} htmlFor="db-host">
                  <T>Host:</T>
                </label>
                <div className={styles.formRow}>
                  <Input
                    id="db-host"
                    className={styles.fill}
                    value={s.host ?? ""}
                    onChange={(e) => set({ host: e.target.value })}
                  />
                  <label className={styles.formLabel} htmlFor="db-port">
                    <T>Port:</T>
                  </label>
                  <Input
                    id="db-port"
                    style={{ width: 80 }}
                    inputMode="numeric"
                    value={s.port ?? ""}
                    placeholder={s.driver === "mysql" ? "3306" : "5432"}
                    onChange={(e) => set({ port: parsePort(e.target.value) })}
                  />
                </div>
                {sshOn && (
                  <>
                    <span />
                    <span className={styles.formHint}>Reached from the SSH host {sshLabel({ ssh })}.</span>
                  </>
                )}
                <label className={styles.formLabel} htmlFor="db-user">
                  <T>User:</T>
                </label>
                <Input id="db-user" value={s.user ?? ""} onChange={(e) => set({ user: e.target.value })} />
                <label className={styles.formLabel} htmlFor="db-password">
                  <T>Password:</T>
                </label>
                <div className={styles.formRow}>
                  <Input
                    id="db-password"
                    className={styles.fill}
                    type="password"
                    value={password ?? ""}
                    placeholder={initial && password === undefined ? "<unchanged>" : ""}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Checkbox
                    checked={!!s.savePassword}
                    onChange={(savePassword) => set({ savePassword })}
                    label="Save password"
                  />
                </div>
                <label className={styles.formLabel} htmlFor="db-database">
                  <T>Database:</T>
                </label>
                <Input id="db-database" value={s.database ?? ""} onChange={(e) => set({ database: e.target.value })} />
              </>
            )}
            <span />
            <Checkbox checked={!!s.readOnly} onChange={(readOnly) => set({ readOnly })} label="Read-only" />
          </>
        ) : (
          <>
            <span />
            <Checkbox checked={!!ssh.enabled} onChange={(enabled) => setSsh({ enabled })} label="Use SSH tunnel" />
            <label className={styles.formLabel} htmlFor="db-ssh-host">
              <T>Host:</T>
            </label>
            <div className={styles.formRow}>
              <Input
                id="db-ssh-host"
                className={styles.fill}
                disabled={!sshOn}
                value={ssh.host ?? ""}
                placeholder={ssh.auth === "openSsh" ? "host or ~/.ssh/config alias" : "bastion.example.com"}
                onChange={(e) => setSsh({ host: e.target.value })}
              />
              <label className={styles.formLabel} htmlFor="db-ssh-port">
                <T>Port:</T>
              </label>
              <Input
                id="db-ssh-port"
                style={{ width: 80 }}
                inputMode="numeric"
                disabled={!sshOn}
                value={ssh.port ?? ""}
                placeholder="22"
                onChange={(e) => setSsh({ port: parsePort(e.target.value) })}
              />
            </div>
            <label className={styles.formLabel} htmlFor="db-ssh-user">
              <T>User:</T>
            </label>
            <Input
              id="db-ssh-user"
              disabled={!sshOn}
              value={ssh.user ?? ""}
              placeholder={ssh.auth === "openSsh" ? "from ~/.ssh/config" : ""}
              onChange={(e) => setSsh({ user: e.target.value })}
            />
            <span className={styles.formLabel}>
              <T>Authentication:</T>
            </span>
            <Select
              aria-label="SSH authentication type"
              disabled={!sshOn}
              value={ssh.auth ?? "openSsh"}
              options={SSH_AUTH}
              onChange={(auth) => setSsh({ auth })}
            />
            {ssh.auth === "keyPair" && (
              <>
                <label className={styles.formLabel} htmlFor="db-ssh-key">
                  <T>Private key:</T>
                </label>
                <div className={styles.formRow}>
                  <Input
                    id="db-ssh-key"
                    className={styles.fill}
                    disabled={!sshOn}
                    value={ssh.keyFile ?? ""}
                    placeholder="~/.ssh/id_ed25519"
                    onChange={(e) => setSsh({ keyFile: e.target.value })}
                  />
                  <Button disabled={!sshOn} onClick={() => void browseKey()}>
                    <T>Browse…</T>
                  </Button>
                </div>
              </>
            )}
            {ssh.auth === "openSsh" ? (
              <>
                <span />
                <span className={styles.formHint}>
                  <T>
                    {
                      "Uses HostName, User, Port, IdentityFile and ProxyJump from ~/.ssh/config, and keys of the SSH agent."
                    }
                  </T>
                </span>
              </>
            ) : (
              <>
                <label className={styles.formLabel} htmlFor="db-ssh-secret">
                  {ssh.auth === "password" ? "Password:" : "Passphrase:"}
                </label>
                <div className={styles.formRow}>
                  <Input
                    id="db-ssh-secret"
                    className={styles.fill}
                    type="password"
                    disabled={!sshOn}
                    value={sshSecret ?? ""}
                    placeholder={initial && sshSecret === undefined ? "<unchanged>" : ""}
                    onChange={(e) => setSshSecret(e.target.value)}
                  />
                  <Checkbox
                    checked={!!ssh.saveSecret}
                    disabled={!sshOn}
                    onChange={(saveSecret) => setSsh({ saveSecret })}
                    label="Save password"
                  />
                </div>
              </>
            )}
            <span className={styles.formLabel}>
              <T>SSL:</T>
            </span>
            <Select aria-label="SSL mode" value={s.ssl ?? "prefer"} options={SSL} onChange={(ssl) => set({ ssl })} />
          </>
        )}
        <div className={`${styles.testResult} ${test?.ok ? styles.ok : styles.bad}`} role="status">
          {busy && !test ? "Connecting…" : test?.text}
          {test?.trust && (
            <>
              {" "}
              <Button size="small" onClick={() => void trustAndRetry()} disabled={busy}>
                <T>Trust Host and Retry</T>
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function PasswordDialog({ source, resolve }: { source: DataSource; resolve: (ok: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(!!source.savePassword);
  const done = (ok: boolean) => {
    closeDialog();
    resolve(ok);
  };
  const submit = async () => {
    await call(commands.dbSetPassword(source.id ?? "", password, save));
    done(true);
  };
  return (
    <Dialog
      open
      onClose={() => done(false)}
      title={`Connect to ${source.name}`}
      width={400}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Connect", role: "default", onClick: () => void submit() },
      ]}
    >
      <div className={styles.form}>
        <span className={styles.formLabel}>
          <T>User:</T>
        </span>
        <span>{source.user || "(default)"}</span>
        <label className={styles.formLabel} htmlFor="db-ask-password">
          <T>Password:</T>
        </label>
        <Input
          id="db-ask-password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span />
        <Checkbox checked={save} onChange={setSave} label="Save password" />
      </div>
    </Dialog>
  );
}

/** SSH password / key passphrase asked on connect. */
function SshSecretDialog({
  source,
  prompt,
  resolve,
}: {
  source: DataSource;
  prompt: string;
  resolve: (ok: boolean) => void;
}) {
  const [secret, setSecret] = useState("");
  const [save, setSave] = useState(!!source.ssh?.saveSecret);
  const password = source.ssh?.auth === "password" || /password required/.test(prompt);
  const done = (ok: boolean) => {
    closeDialog();
    resolve(ok);
  };
  const submit = async () => {
    await call(commands.dbSetSshSecret(source.id ?? "", secret, save));
    done(true);
  };
  return (
    <Dialog
      open
      onClose={() => done(false)}
      title={`SSH: ${sshLabel(source) || source.name}`}
      width={440}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Connect", role: "default", onClick: () => void submit() },
      ]}
    >
      <div className={styles.form}>
        <span />
        <span className={styles.formHint}>{prompt}</span>
        <label className={styles.formLabel} htmlFor="db-ask-ssh-secret">
          {password ? "Password:" : "Passphrase:"}
        </label>
        <Input
          id="db-ask-ssh-secret"
          type="password"
          autoFocus
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <span />
        <Checkbox checked={save} onChange={setSave} label="Save password" />
      </div>
    </Dialog>
  );
}

/** First connection to an SSH host: trust its key (added to ~/.ssh/known_hosts)? */
function HostKeyDialog({ prompt, resolve }: { prompt: string; resolve: (ok: boolean) => void }) {
  const done = (ok: boolean) => {
    closeDialog();
    resolve(ok);
  };
  return (
    <Dialog
      open
      onClose={() => done(false)}
      title="Unknown SSH Host"
      icon="warning"
      width={480}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Trust and Connect", role: "default", onClick: () => done(true) },
      ]}
    >
      {prompt}. The authenticity of the host cannot be established. Trust it and add the key to ~/.ssh/known_hosts?
    </Dialog>
  );
}

/** Overlay host: whichever dialog the store asks for. */
/** IDEA's parameter dialog: one SQL value per query parameter, remembered for the next run. */
function ParamsDialog({
  names,
  resolve,
}: {
  names: string[];
  resolve: (values: Record<string, string> | null) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const last = useDatabase.getState().paramValues;
    return Object.fromEntries(names.map((n) => [n, last[n] ?? ""]));
  });
  const done = (v: Record<string, string> | null) => {
    closeDialog();
    resolve(v);
  };
  return (
    <Dialog
      open
      onClose={() => done(null)}
      title="Parameters"
      width={480}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Execute", role: "default", onClick: () => done(values) },
      ]}
    >
      <div
        className={styles.form}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          done(values);
        }}
      >
        {names.map((n, i) => (
          <Fragment key={n}>
            <label className={styles.formLabel} htmlFor={`db-param-${i}`}>
              {n}
            </label>
            <Input
              id={`db-param-${i}`}
              className={styles.paramInput}
              autoFocus={i === 0}
              value={values[n] ?? ""}
              placeholder="NULL"
              onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
            />
          </Fragment>
        ))}
        <span />
        <span className={styles.formHint}>
          <T>Values are inserted as SQL: quote strings, e.g. 'abc'.</T>
        </span>
      </div>
    </Dialog>
  );
}

/** Leaving manual commit with changes pending (IDEA asks the same). */
function EndTransactionDialog({ source, resolve }: { source: DataSource; resolve: (commit: boolean | null) => void }) {
  const done = (v: boolean | null) => {
    closeDialog();
    resolve(v);
  };
  return (
    <Dialog
      open
      onClose={() => done(null)}
      title="Switch to Auto-Commit"
      icon="question"
      width={460}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Roll Back", onClick: () => done(false) },
        { label: "Commit", role: "default", onClick: () => done(true) },
      ]}
    >
      {source.name} has uncommitted changes. Commit or roll them back before switching to auto-commit?
    </Dialog>
  );
}

export function DatabaseDialogs() {
  const dialog = useDatabase((s) => s.dialog);
  if (!dialog) return null;
  if (dialog.kind === "source")
    return (
      <SourceDialog
        key={dialog.source?.id ?? "new"}
        initial={dialog.source}
        preset={dialog.preset}
        presetPassword={dialog.password}
      />
    );
  if (dialog.kind === "params") return <ParamsDialog names={dialog.names} resolve={dialog.resolve} />;
  if (dialog.kind === "endTransaction") return <EndTransactionDialog source={dialog.source} resolve={dialog.resolve} />;
  if (dialog.kind === "sshSecret")
    return (
      <SshSecretDialog key={dialog.source.id} source={dialog.source} prompt={dialog.prompt} resolve={dialog.resolve} />
    );
  if (dialog.kind === "hostKey") return <HostKeyDialog prompt={dialog.prompt} resolve={dialog.resolve} />;
  if (dialog.kind === "password")
    return <PasswordDialog key={dialog.source.id} source={dialog.source} resolve={dialog.resolve} />;
  return <ObjectDialogs />;
}
