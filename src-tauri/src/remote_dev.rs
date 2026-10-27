//! Remote development (client side): a window whose project lives on another
//! machine. The backend there is `openidea-server`, started over SSH; the
//! frontend's remote-capable commands go through [`remote_invoke`] instead of
//! running locally.

use crate::events::TauriSink;
use crate::state::AppState;
use ide_core::{EventSink, IdeError, IdeResult};
use ide_host::rpc::{ChannelMessage, EventMessage, Invoke, ServerInfo};
use ide_jsonrpc::{Handler, Peer};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Window};

/// Where the server is installed on the remote host (per version).
fn install_dir(version: &str) -> String {
    format!("~/.openidea/server/{version}")
}

/// One remote window's connection.
pub struct Connection {
    peer: Peer,
    pub ssh_config: String,
    pub root: String,
    pub host: String,
    pub commands: Vec<String>,
    /// Streaming arguments by id: the frontend channel and the id it expects.
    channels: Arc<Mutex<HashMap<u64, Channel<ChannelFrame>>>>,
    _session: Arc<ide_ssh::Session>,
}

#[derive(Default)]
pub struct Connections(Mutex<HashMap<String, Arc<Connection>>>);

impl Connections {
    pub fn get(&self, window: &str) -> Option<Arc<Connection>> {
        self.0.lock().get(window).cloned()
    }

    pub fn disconnect(&self, window: &str) {
        if let Some(c) = self.0.lock().remove(window) {
            c.peer.kill();
        }
    }
}

/// A value for one streaming argument of a remote command (`data`: JSON text).
#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelFrame {
    pub id: u64,
    pub data: String,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub ssh_config: String,
    pub root: String,
    /// `user@host:port` of the SSH configuration.
    pub host: String,
    pub server_version: String,
    pub os: String,
    /// Commands the server answers (the rest run locally).
    pub commands: Vec<String>,
    pub project: ide_host::ops::project::ProjectInfo,
}

struct ClientHandler {
    app: AppHandle,
    window: String,
    channels: Arc<Mutex<HashMap<u64, Channel<ChannelFrame>>>>,
}

impl Handler for ClientHandler {
    fn on_notification(&self, method: &str, params: Value) {
        match method {
            "event" => match serde_json::from_value::<EventMessage>(params) {
                Ok(m) => {
                    // The server's windows are this window.
                    let _ = m.window;
                    TauriSink { app: self.app.clone(), window: Some(self.window.clone()) }.emit(m.event);
                }
                Err(e) => tracing::warn!("remote event: {e}"),
            },
            "channel" => match serde_json::from_value::<ChannelMessage>(params) {
                Ok(m) => {
                    let channel = self.channels.lock().get(&m.id).cloned();
                    if let Some(c) = channel {
                        let _ = c.send(ChannelFrame { id: m.id, data: m.data.to_string() });
                    }
                }
                Err(e) => tracing::warn!("remote channel: {e}"),
            },
            _ => {}
        }
    }

    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, format!("unhandled method {method}")))
    }
}

/// The server binary for a remote `os`/`arch`: `OPENIDEA_SERVER_BINARY`, then
/// `<data dir>/server/<os>-<arch>/openidea-server`, then one next to this app
/// when the platforms match.
fn local_server_binary(state: &AppState, os: &str, arch: &str) -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("OPENIDEA_SERVER_BINARY").map(std::path::PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    let bundled = state.data_dir.join("server").join(format!("{os}-{arch}")).join("openidea-server");
    if bundled.is_file() {
        return Some(bundled);
    }
    if os == std::env::consts::OS && arch == std::env::consts::ARCH {
        let exe = std::env::current_exe().ok()?;
        let name = if cfg!(windows) { "openidea-server.exe" } else { "openidea-server" };
        let sibling = exe.parent()?.join(name);
        if sibling.is_file() {
            return Some(sibling);
        }
    }
    None
}

/// The release build of the server for `os`/`arch`, downloaded once into the data dir.
async fn download_server(state: &AppState, version: &str, os: &str, arch: &str) -> IdeResult<std::path::PathBuf> {
    let (data, version, os, arch) = (state.data_dir.clone(), version.to_owned(), os.to_owned(), arch.to_owned());
    tokio::task::spawn_blocking(move || {
        ide_tools::server::fetch(&data, &version, &os, &arch, &ide_core::CancellationToken::new(), &|e| {
            if let ide_tools::InstallEvent::Line { text } = e {
                tracing::info!("openidea-server download: {text}");
            }
        })
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// `uname -sm` → (`linux` | `macos`, `x86_64` | `aarch64`), as Rust names them.
fn platform(uname: &str) -> (String, String) {
    let mut parts = uname.split_whitespace();
    let os = match parts.next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "darwin" => "macos".to_owned(),
        other => other.to_owned(),
    };
    let arch = match parts.next().unwrap_or_default() {
        "arm64" => "aarch64".to_owned(),
        "amd64" => "x86_64".to_owned(),
        other => other.to_owned(),
    };
    (os, arch)
}

/// Makes sure this version of the server is installed on the host; returns its path.
async fn ensure_server(state: &AppState, session: &ide_ssh::Session) -> IdeResult<String> {
    let version = env!("CARGO_PKG_VERSION");
    let dir = install_dir(version);
    let q = ide_ssh::shell::tilde_quote;
    let probe =
        session.exec(&format!("uname -sm; ls -d {}/*/openidea-server 2>/dev/null", q(&dir)), None).await?.stdout_str();
    let mut lines = probe.lines();
    let (os, arch) = platform(lines.next().unwrap_or_default());
    let installed: Vec<&str> = lines.collect();
    let local = match local_server_binary(state, &os, &arch) {
        Some(local) => local,
        None => match download_server(state, version, &os, &arch).await {
            Ok(local) => local,
            // Offline: any build of this version already on the host will do.
            Err(e) => {
                return installed.first().map(|b| b.to_string()).ok_or_else(|| {
                    IdeError::unavailable(format!(
                        "no openidea-server {version} for {os}-{arch} ({}). Build it with \
                         `cargo build --release -p ide-host --bin openidea-server` for that platform and put it at {} \
                         (or set OPENIDEA_SERVER_BINARY)",
                        e.message,
                        state.data_dir.join("server").join(format!("{os}-{arch}")).join("openidea-server").display()
                    ))
                });
            }
        },
    };
    // One folder per build, so a rebuilt server of the same version is installed again.
    let build = tokio::task::spawn_blocking({
        let local = local.clone();
        move || build_id(&local)
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))??;
    if let Some(bin) = installed.iter().find(|b| b.ends_with(&format!("/{build}/openidea-server"))) {
        return Ok(bin.to_string());
    }
    let fs = ide_ssh::RemoteFs::new(session.sftp().await?);
    let remote_dir = fs.resolve(&dir).await;
    fs.close().await;
    let remote_dir = remote_dir?;
    let remote_bin = ide_ssh::sftp::join(&ide_ssh::sftp::join(&remote_dir, &build), "openidea-server");
    let tmp = format!("{remote_bin}.part");
    let started = std::time::Instant::now();
    session.put(&tmp, &tokio::fs::read(&local).await?).await?;
    tracing::info!("installed openidea-server on {} in {:?}", session.label(), started.elapsed());
    let q = ide_ssh::shell::quote;
    // Older builds of this version go (a running one keeps its open file).
    session
        .exec(
            &format!(
                "chmod 755 {tmp} && mv -f {tmp} {bin} && find {dir} -mindepth 1 -maxdepth 1 ! -name {build} -exec rm -rf {{}} +",
                tmp = q(&tmp),
                bin = q(&remote_bin),
                dir = q(&remote_dir),
                build = q(&build),
            ),
            None,
        )
        .await?
        .into_stdout("installing openidea-server")?;
    Ok(remote_bin)
}

/// A short content hash of the server binary (cached per path, size and time).
fn build_id(path: &std::path::Path) -> IdeResult<String> {
    static CACHE: Mutex<Option<(std::path::PathBuf, u64, std::time::SystemTime, String)>> = Mutex::new(None);
    let meta = std::fs::metadata(path)?;
    let modified = meta.modified()?;
    if let Some((p, len, time, id)) = &*CACHE.lock()
        && p == path
        && *len == meta.len()
        && *time == modified
    {
        return Ok(id.clone());
    }
    let id = blake3::hash(&std::fs::read(path)?).to_hex()[..16].to_owned();
    *CACHE.lock() = Some((path.to_path_buf(), meta.len(), modified, id.clone()));
    Ok(id)
}

/// File › Remote Development: opens `path` on the host of SSH configuration
/// `ssh_config` in this window (installs / starts the server as needed).
#[tauri::command]
#[specta::specta]
pub async fn remote_connect(
    window: Window,
    state: State<'_, AppState>,
    ssh_config: String,
    path: String,
) -> IdeResult<RemoteProject> {
    let label = AppState::owner_window(window.label()).to_owned();
    state.remote_dev.disconnect(&label);
    state.host.close_project(&label);
    let config = state.ssh.config(&ssh_config)?;
    let session = state.ssh.session(&ssh_config).await?;
    let bin = ensure_server(&state, &session).await?;
    let stream = session
        .exec_stream(&format!("{} --stdio", ide_ssh::shell::tilde_quote(&bin)))
        .await
        .map_err(|e| IdeError::unavailable(format!("cannot start openidea-server: {e}")))?;
    let (reader, writer) = tokio::io::split(stream);
    let channels: Arc<Mutex<HashMap<u64, Channel<ChannelFrame>>>> = Arc::default();
    let handler =
        Arc::new(ClientHandler { app: window.app_handle().clone(), window: label.clone(), channels: channels.clone() });
    let peer = Peer::connect(reader, writer, handler);
    let info: ServerInfo = peer
        .request("initialize", serde_json::json!({ "version": ide_host::rpc::PROTOCOL_VERSION }), None)
        .await
        .map_err(ide_host::rpc::error_from_reply)?;
    if info.protocol != ide_host::rpc::PROTOCOL_VERSION {
        return Err(IdeError::unavailable(format!(
            "openidea-server {} speaks protocol {}, this app {}",
            info.version,
            info.protocol,
            ide_host::rpc::PROTOCOL_VERSION
        )));
    }
    let commands: Vec<String> =
        peer.request("commands", Value::Null, None).await.map_err(ide_host::rpc::error_from_reply)?;
    let root = if path.trim().is_empty() || path.trim() == "~" {
        info.home.clone()
    } else if let Some(rest) = path.trim().strip_prefix("~/") {
        format!("{}/{rest}", info.home.trim_end_matches('/'))
    } else {
        path.trim().to_owned()
    };
    let call = Invoke { window: label.clone(), cmd: "open_project".into(), args: serde_json::json!({ "path": root }) };
    let project: ide_host::ops::project::ProjectInfo =
        peer.request("invoke", call, None).await.map_err(ide_host::rpc::error_from_reply)?;
    let _ = window.set_title(&format!("{} [{}]", project.name, config.label()));
    let connection = Arc::new(Connection {
        peer,
        ssh_config: ssh_config.clone(),
        root: root.clone(),
        host: config.label(),
        commands: commands.clone(),
        channels,
        _session: session,
    });
    state.remote_dev.0.lock().insert(label, connection);
    Ok(RemoteProject {
        ssh_config,
        root,
        host: config.label(),
        server_version: info.version,
        os: info.os,
        commands,
        project,
    })
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    pub ssh_config: String,
    pub root: String,
    pub host: String,
    pub commands: Vec<String>,
}

/// The remote session of this window (a settings window: its parent's), if any.
#[tauri::command]
#[specta::specta]
pub fn remote_current(window: Window, state: State<'_, AppState>) -> Option<RemoteSession> {
    let c = state.remote_dev.get(AppState::owner_window(window.label()))?;
    Some(RemoteSession {
        ssh_config: c.ssh_config.clone(),
        root: c.root.clone(),
        host: c.host.clone(),
        commands: c.commands.clone(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn remote_disconnect(window: Window, state: State<'_, AppState>) {
    state.remote_dev.disconnect(AppState::owner_window(window.label()));
}

/// Runs a command on the window's remote server; `args` and the result are JSON
/// text. Streaming arguments are `{ "$channel": id }`; their values arrive on
/// `on_channel` tagged with the id.
#[tauri::command]
#[specta::specta]
pub async fn remote_invoke(
    window: Window,
    state: State<'_, AppState>,
    cmd: String,
    args: String,
    on_channel: Channel<ChannelFrame>,
) -> IdeResult<String> {
    let args: Value = serde_json::from_str(&args).map_err(|e| IdeError::invalid(format!("arguments: {e}")))?;
    let label = AppState::owner_window(window.label()).to_owned();
    let c = state
        .remote_dev
        .get(&label)
        .ok_or_else(|| IdeError::unavailable("this window is not connected to a remote host"))?;
    if let Value::Object(map) = &args {
        for v in map.values() {
            if let Some(id) = v.get("$channel").and_then(Value::as_u64) {
                c.channels.lock().insert(id, on_channel.clone());
            }
        }
    }
    let call = Invoke { window: label, cmd, args };
    let result: Value = c.peer.request("invoke", call, None).await.map_err(ide_host::rpc::error_from_reply)?;
    Ok(result.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_uname_to_rust_platform_names() {
        assert_eq!(platform("Linux x86_64"), ("linux".into(), "x86_64".into()));
        assert_eq!(platform("Darwin arm64"), ("macos".into(), "aarch64".into()));
        assert_eq!(platform("Linux aarch64"), ("linux".into(), "aarch64".into()));
    }
}
