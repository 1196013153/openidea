//! SSH tunnels for data sources: a listener on 127.0.0.1 whose connections are
//! forwarded to the database through `direct-tcpip` channels of an SSH session
//! (russh), optionally reached through `ProxyJump` hosts.
//!
//! Host keys are checked against `known_hosts`; an unknown key fails the
//! connection with [`OpenError::UnknownHostKey`] so the UI can ask the user,
//! and a changed key is always refused.

use crate::source::{DbSsh, DbSshAuth};
use ide_core::{IdeError, IdeResult, error::ErrorKind};
use parking_lot::Mutex;
use russh::client::{self, Handle};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate, known_hosts};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// Generous: a relayed VPN path (e.g. Tailscale via DERP) can take ~1 s per round trip.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);
const DEFAULT_IDENTITIES: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

/// A host key the user has not trusted yet.
#[derive(Debug, Clone)]
pub struct UnknownHostKey {
    pub host: String,
    pub port: u16,
    pub key: PublicKey,
}

impl UnknownHostKey {
    /// `ED25519 SHA256:…`, as OpenSSH prints it.
    pub fn fingerprint(&self) -> String {
        format!("{} {}", self.key.algorithm().as_str(), self.key.fingerprint(HashAlg::Sha256))
    }

    /// Records the key in `known_hosts` (blocking).
    pub fn trust(&self, known_hosts: &Path) -> IdeResult<()> {
        known_hosts::learn_known_hosts_path(&self.host, self.port, &self.key, known_hosts)
            .map_err(|e| IdeError::new(ErrorKind::Io, format!("cannot update {}: {e}", known_hosts.display())))
    }
}

#[derive(Debug)]
pub enum OpenError {
    UnknownHostKey(Box<UnknownHostKey>),
    Other(IdeError),
}

impl From<IdeError> for OpenError {
    fn from(e: IdeError) -> Self {
        OpenError::Other(e)
    }
}

/// Where and how to connect.
pub struct TunnelSpec<'a> {
    pub ssh: &'a DbSsh,
    /// SSH password or key passphrase.
    pub secret: Option<&'a str>,
    /// The database, as seen from the SSH host.
    pub target_host: &'a str,
    pub target_port: u16,
    pub known_hosts: &'a Path,
    /// `~/.ssh/config` (used with [`DbSshAuth::OpenSsh`]).
    pub ssh_config: Option<&'a Path>,
}

/// An open tunnel; dropping it stops forwarding and closes the SSH sessions.
pub struct Tunnel {
    port: u16,
    session: Arc<Handle<Client>>,
    /// Sessions of the `ProxyJump` hosts, kept alive under `session`.
    _jumps: Vec<Handle<Client>>,
    accept: JoinHandle<()>,
}

impl Tunnel {
    /// Connects and starts listening on a free local port.
    pub async fn open(spec: TunnelSpec<'_>) -> Result<Tunnel, OpenError> {
        let host = format!("{}:{}", spec.ssh.host, spec.ssh.port.unwrap_or(22));
        match tokio::time::timeout(CONNECT_TIMEOUT, Self::open_inner(spec)).await {
            Ok(r) => r,
            Err(_) => Err(IdeError::new(
                ErrorKind::Io,
                format!("timed out connecting to the SSH host {host} ({} s)", CONNECT_TIMEOUT.as_secs()),
            )
            .into()),
        }
    }

    async fn open_inner(spec: TunnelSpec<'_>) -> Result<Tunnel, OpenError> {
        let hops = resolve_hops(spec.ssh, spec.ssh_config)?;
        let mut sessions: Vec<Handle<Client>> = Vec::new();
        for (i, hop) in hops.iter().enumerate() {
            let target = i == hops.len() - 1;
            let mut handle = match sessions.last() {
                None => connect::<tokio::net::TcpStream>(hop, spec.known_hosts, None).await?,
                Some(prev) => {
                    let channel = prev
                        .channel_open_direct_tcpip(hop.host.as_str(), u32::from(hop.port), "127.0.0.1", 0)
                        .await
                        .map_err(|e| io(format!("cannot reach {} through the jump host: {e}", hop.label())))?;
                    connect(hop, spec.known_hosts, Some(channel.into_stream())).await?
                }
            };
            // Jump hosts always use the agent / identity files; the secret belongs to the target.
            let mode = if target { spec.ssh.auth } else { DbSshAuth::OpenSsh };
            authenticate(&mut handle, hop, mode, &spec.ssh.key_file, spec.secret).await?;
            sessions.push(handle);
        }
        let session = Arc::new(sessions.pop().expect("at least one hop"));
        // Fail fast with the real reason when the SSH host cannot reach the database
        // (a refused forward otherwise surfaces as the driver's connect timeout).
        let via = hops.last().expect("at least one hop").label();
        session
            .channel_open_direct_tcpip(spec.target_host, u32::from(spec.target_port), "127.0.0.1", 0)
            .await
            .map_err(|e| unreachable_target(&via, spec.target_host, spec.target_port, &e))?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| io(e.to_string()))?;
        let port = listener.local_addr().map_err(|e| io(e.to_string()))?.port();
        let accept = tokio::spawn(forward(listener, session.clone(), spec.target_host.to_owned(), spec.target_port));
        Ok(Tunnel { port, session, _jumps: sessions, accept })
    }

    /// The local port to connect to instead of the database.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The SSH session ended (network loss, server restart).
    pub fn is_closed(&self) -> bool {
        self.session.is_closed()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

async fn forward(listener: TcpListener, session: Arc<Handle<Client>>, host: String, port: u16) {
    loop {
        let Ok((mut socket, peer)) = listener.accept().await else { return };
        let session = session.clone();
        let host = host.clone();
        tokio::spawn(async move {
            match session
                .channel_open_direct_tcpip(host.as_str(), u32::from(port), "127.0.0.1", u32::from(peer.port()))
                .await
            {
                Ok(channel) => {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                }
                Err(e) => tracing::warn!("SSH tunnel: cannot open a channel to {host}:{port}: {e}"),
            }
        });
    }
}

fn unreachable_target(via: &str, host: &str, port: u16, e: &russh::Error) -> IdeError {
    let why = match e {
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed) => {
            "connection refused or host unreachable"
        }
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited) => {
            "port forwarding is not allowed by the SSH server (AllowTcpForwarding)"
        }
        _ => "",
    };
    let why = if why.is_empty() { e.to_string() } else { why.to_owned() };
    io(format!("SSH host {via} cannot reach the database at {host}:{port}: {why}"))
}

fn io(message: impl Into<String>) -> IdeError {
    IdeError::new(ErrorKind::Io, message)
}

// --- hosts ---------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Hop {
    host: String,
    port: u16,
    user: String,
    identity_files: Vec<PathBuf>,
}

impl Hop {
    fn label(&self) -> String {
        format!("{}@{}:{}", self.user, self.host, self.port)
    }
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// `~/x` → `$HOME/x`.
pub(crate) fn expand(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), home()) {
        (Some(rest), Some(h)) => h.join(rest),
        _ => PathBuf::from(path),
    }
}

fn local_user() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// One `~/.ssh/config` lookup (a missing or unreadable file means defaults).
fn config_hop(config: Option<&Path>, alias: &str) -> (Hop, Option<String>) {
    let c = config
        .and_then(|p| russh_config::parse_path(p, alias).ok())
        .unwrap_or_else(|| russh_config::Config::default(alias));
    let identity_files = c.host_config.identity_file.clone().unwrap_or_default();
    let hop = Hop { host: c.host().to_owned(), port: c.port(), user: c.user(), identity_files };
    (hop, c.host_config.proxy_jump.clone())
}

/// `[user@]host[:port]` of a `ProxyJump` entry.
fn jump_hop(config: Option<&Path>, spec: &str) -> Hop {
    let (user, rest) = match spec.rsplit_once('@') {
        Some((u, r)) => (Some(u), r),
        None => (None, spec),
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() => (h, p.parse().ok()),
        _ => (rest, None),
    };
    let (mut hop, _) = config_hop(config, host);
    if let Some(u) = user {
        hop.user = u.to_owned();
    }
    if let Some(p) = port {
        hop.port = p;
    }
    hop
}

/// The SSH hosts to go through, the tunnel's host last.
fn resolve_hops(ssh: &DbSsh, config: Option<&Path>) -> IdeResult<Vec<Hop>> {
    let host = ssh.host.trim();
    if host.is_empty() {
        return Err(IdeError::invalid("SSH host is empty"));
    }
    let (mut hop, proxy_jump) = if ssh.auth == DbSshAuth::OpenSsh {
        config_hop(config, host)
    } else {
        (Hop { host: host.to_owned(), port: 22, user: local_user(), identity_files: Vec::new() }, None)
    };
    if let Some(p) = ssh.port {
        hop.port = p;
    }
    if !ssh.user.trim().is_empty() {
        hop.user = ssh.user.trim().to_owned();
    }
    let mut hops: Vec<Hop> = proxy_jump
        .filter(|j| !j.eq_ignore_ascii_case("none"))
        .map(|j| j.split(',').map(str::trim).filter(|s| !s.is_empty()).map(|s| jump_hop(config, s)).collect())
        .unwrap_or_default();
    hops.push(hop);
    Ok(hops)
}

// --- connection ----------------------------------------------------------------

#[derive(Debug)]
enum HostKeyIssue {
    Unknown(PublicKey),
    Changed(usize),
}

pub struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    issue: Arc<Mutex<Option<HostKeyIssue>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        let issue = match known_hosts::check_known_hosts_path(&self.host, self.port, &key, &self.known_hosts) {
            Ok(true) => return Ok(true),
            Err(keys::Error::KeyChanged { line }) => HostKeyIssue::Changed(line),
            Ok(false) | Err(_) => HostKeyIssue::Unknown(key),
        };
        *self.issue.lock() = Some(issue);
        Ok(false)
    }
}

async fn connect<S>(hop: &Hop, known_hosts: &Path, stream: Option<S>) -> Result<Handle<Client>, OpenError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    let issue = Arc::new(Mutex::new(None));
    let handler =
        Client { host: hop.host.clone(), port: hop.port, known_hosts: known_hosts.to_owned(), issue: issue.clone() };
    let result = match stream {
        None => client::connect(config, (hop.host.as_str(), hop.port), handler).await,
        Some(s) => client::connect_stream(config, s, handler).await,
    };
    result.map_err(|e| match issue.lock().take() {
        Some(HostKeyIssue::Unknown(key)) => {
            OpenError::UnknownHostKey(Box::new(UnknownHostKey { host: hop.host.clone(), port: hop.port, key }))
        }
        Some(HostKeyIssue::Changed(line)) => OpenError::Other(IdeError::new(
            ErrorKind::PermissionDenied,
            format!(
                "SSH host key of {}:{} has changed (known_hosts line {line}); possible man-in-the-middle attack",
                hop.host, hop.port
            ),
        )),
        None => OpenError::Other(io(format!("cannot connect to SSH host {}:{}: {e}", hop.host, hop.port))),
    })
}

// --- authentication ------------------------------------------------------------

fn denied(message: String) -> IdeError {
    IdeError::new(ErrorKind::PermissionDenied, message)
}

async fn rsa_hash(handle: &Handle<Client>) -> Option<HashAlg> {
    handle.best_supported_rsa_hash().await.ok().flatten().flatten()
}

async fn with_key(handle: &mut Handle<Client>, user: &str, key: keys::PrivateKey) -> IdeResult<bool> {
    let key = PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash(handle).await);
    let r = handle.authenticate_publickey(user, key).await.map_err(|e| io(e.to_string()))?;
    Ok(r.success())
}

/// Every identity of the running SSH agent, until one is accepted.
async fn with_agent(handle: &mut Handle<Client>, user: &str) -> bool {
    #[cfg(unix)]
    let agent = keys::agent::client::AgentClient::connect_env().await;
    #[cfg(windows)]
    let agent = keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await;
    let Ok(mut agent) = agent else { return false };
    let Ok(identities) = agent.request_identities().await else { return false };
    let hash = rsa_hash(handle).await;
    for id in identities {
        let ok = match id {
            keys::agent::AgentIdentity::PublicKey { key, .. } => {
                handle.authenticate_publickey_with(user, key, hash, &mut agent).await.map(|r| r.success())
            }
            keys::agent::AgentIdentity::Certificate { certificate, .. } => {
                handle.authenticate_certificate_with(user, certificate, hash, &mut agent).await.map(|r| r.success())
            }
        };
        if ok.unwrap_or(false) {
            return true;
        }
    }
    false
}

async fn authenticate(
    handle: &mut Handle<Client>,
    hop: &Hop,
    mode: DbSshAuth,
    key_file: &str,
    secret: Option<&str>,
) -> IdeResult<()> {
    let user = hop.user.as_str();
    let failed = || denied(format!("SSH authentication failed for {}", hop.label()));
    match mode {
        DbSshAuth::Password => {
            let Some(password) = secret else {
                return Err(denied(format!("SSH password required for {}", hop.label())));
            };
            let r = handle.authenticate_password(user, password).await.map_err(|e| io(e.to_string()))?;
            if r.success() { Ok(()) } else { Err(failed()) }
        }
        DbSshAuth::KeyPair => {
            if key_file.trim().is_empty() {
                return Err(IdeError::invalid("SSH private key file is not set"));
            }
            let path = expand(key_file.trim());
            let key = load_key(&path, secret)?;
            if with_key(handle, user, key).await? { Ok(()) } else { Err(failed()) }
        }
        DbSshAuth::OpenSsh => {
            if with_agent(handle, user).await {
                return Ok(());
            }
            let files: Vec<PathBuf> = if hop.identity_files.is_empty() {
                home().map(|h| DEFAULT_IDENTITIES.iter().map(|n| h.join(".ssh").join(n)).collect()).unwrap_or_default()
            } else {
                hop.identity_files.iter().map(|p| expand(&p.to_string_lossy())).collect()
            };
            let mut locked: Option<PathBuf> = None;
            for path in files.iter().filter(|p| p.is_file()) {
                match load_key(path, secret) {
                    Ok(key) => {
                        if with_key(handle, user, key).await? {
                            return Ok(());
                        }
                    }
                    Err(e) if e.kind == ErrorKind::PermissionDenied => locked = locked.or(Some(path.clone())),
                    Err(e) => tracing::warn!("SSH key {}: {}", path.display(), e.message),
                }
            }
            match locked {
                // An encrypted key could not be tried: ask for its passphrase.
                Some(path) if secret.is_none() => {
                    Err(denied(format!("SSH key passphrase required for {}", path.display())))
                }
                _ => Err(failed()),
            }
        }
    }
}

/// Loads a private key; an encrypted key without (or with a wrong) passphrase is `PermissionDenied`.
fn load_key(path: &Path, passphrase: Option<&str>) -> IdeResult<keys::PrivateKey> {
    match keys::load_secret_key(path, passphrase) {
        Ok(k) => Ok(k),
        Err(keys::Error::KeyIsEncrypted) => Err(denied(format!("SSH key passphrase required for {}", path.display()))),
        Err(e) if passphrase.is_some() => {
            Err(denied(format!("cannot decrypt SSH key {} (wrong passphrase?): {e}", path.display())))
        }
        Err(e) => Err(IdeError::invalid(format!("cannot read SSH key {}: {e}", path.display()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_aliases_and_proxy_jumps_from_ssh_config() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::write(
            &config,
            "Host db-bastion\n  HostName 10.0.0.5\n  User ops\n  Port 2222\n  ProxyJump jump@gw.example.com:2200,edge\n  IdentityFile /keys/id_bastion\n\nHost edge\n  HostName edge.example.com\n  User edgeuser\n",
        )
        .unwrap();
        let ssh = DbSsh { enabled: true, host: "db-bastion".into(), auth: DbSshAuth::OpenSsh, ..Default::default() };
        let hops = resolve_hops(&ssh, Some(&config)).unwrap();
        let labels: Vec<String> = hops.iter().map(Hop::label).collect();
        assert_eq!(labels, ["jump@gw.example.com:2200", "edgeuser@edge.example.com:22", "ops@10.0.0.5:2222"]);
        assert_eq!(hops[2].identity_files, [PathBuf::from("/keys/id_bastion")]);

        // Explicit fields win over the config.
        let ssh = DbSsh { user: "me".into(), port: Some(22), ..ssh };
        assert_eq!(resolve_hops(&ssh, Some(&config)).unwrap()[2].label(), "me@10.0.0.5:22");

        // Without OpenSSH mode the host is used as is.
        let ssh = DbSsh { auth: DbSshAuth::Password, user: "u".into(), port: None, ..ssh };
        let hops = resolve_hops(&ssh, Some(&config)).unwrap();
        assert_eq!(hops.iter().map(Hop::label).collect::<Vec<_>>(), ["u@db-bastion:22"]);
        assert!(resolve_hops(&DbSsh::default(), None).is_err());
    }
}
