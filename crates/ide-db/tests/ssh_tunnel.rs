//! SSH tunnels against an in-process russh server that forwards `direct-tcpip`
//! channels to a local echo server.

use ide_core::error::ErrorKind;
use ide_db::tunnel::{OpenError, Tunnel, TunnelSpec};
use ide_db::{DbSsh, DbSshAuth};
use russh::Channel;
use russh::keys::{PrivateKey, PublicKey, decode_secret_key};
use russh::server::{self, Auth, ChannelOpenHandle, Msg, Server as _, Session};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ssh").join(name)
}

fn key(name: &str, passphrase: Option<&str>) -> PrivateKey {
    decode_secret_key(&std::fs::read_to_string(fixture(name)).unwrap(), passphrase).unwrap()
}

#[derive(Clone)]
struct Sshd {
    client_key: PublicKey,
}

impl server::Server for Sshd {
    type Handler = Sshd;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Sshd {
        self.clone()
    }
}

impl server::Handler for Sshd {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == "dev" && password == "secret" { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        Ok(if user == "dev" && key.key_data() == self.client_key.key_data() { Auth::Accept } else { Auth::reject() })
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Ok(mut upstream) = TcpStream::connect((host, port as u16)).await else {
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
        });
        Ok(())
    }
}

/// Echo server standing in for the database.
async fn echo() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    port
}

async fn sshd() -> u16 {
    let config = Arc::new(server::Config {
        keys: vec![key("host", None)],
        auth_rejection_time: std::time::Duration::from_millis(10),
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut server = Sshd { client_key: key("client", None).public_key().clone() };
    tokio::spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
    });
    port
}

struct Env {
    _tmp: tempfile::TempDir,
    known_hosts: PathBuf,
    ssh_port: u16,
    db_port: u16,
}

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let known_hosts = tmp.path().join("known_hosts");
    Env { known_hosts, _tmp: tmp, ssh_port: sshd().await, db_port: echo().await }
}

impl Env {
    fn ssh(&self, auth: DbSshAuth) -> DbSsh {
        DbSsh {
            enabled: true,
            host: "127.0.0.1".into(),
            port: Some(self.ssh_port),
            user: "dev".into(),
            auth,
            ..Default::default()
        }
    }

    async fn open(&self, ssh: &DbSsh, secret: Option<&str>) -> Result<Tunnel, OpenError> {
        Tunnel::open(TunnelSpec {
            ssh,
            secret,
            target_host: "127.0.0.1",
            target_port: self.db_port,
            known_hosts: &self.known_hosts,
            ssh_config: None,
        })
        .await
    }

    /// Trusts the server's key on the first connection, as the UI does.
    async fn open_trusted(&self, ssh: &DbSsh, secret: Option<&str>) -> Result<Tunnel, OpenError> {
        match self.open(ssh, secret).await {
            Err(OpenError::UnknownHostKey(k)) => {
                k.trust(&self.known_hosts).unwrap();
                self.open(ssh, secret).await
            }
            other => other,
        }
    }
}

async fn round_trip(t: &Tunnel) {
    let mut s = TcpStream::connect(("127.0.0.1", t.port())).await.unwrap();
    s.write_all(b"SELECT 1").await.unwrap();
    let mut buf = [0u8; 8];
    s.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"SELECT 1");
}

fn denied(r: Result<Tunnel, OpenError>) -> String {
    match r {
        Err(OpenError::Other(e)) if e.kind == ErrorKind::PermissionDenied => e.message,
        Err(OpenError::Other(e)) => panic!("expected permission denied, got {e:?}"),
        Err(OpenError::UnknownHostKey(k)) => panic!("unexpected unknown host key {}", k.fingerprint()),
        Ok(_) => panic!("expected permission denied, connected"),
    }
}

#[tokio::test]
async fn unknown_host_key_must_be_trusted_and_changed_key_is_refused() {
    let env = env().await;
    let ssh = env.ssh(DbSshAuth::Password);
    let Err(OpenError::UnknownHostKey(k)) = env.open(&ssh, Some("secret")).await else {
        panic!("expected an unknown host key");
    };
    assert!(k.fingerprint().starts_with("ssh-ed25519 SHA256:"), "{}", k.fingerprint());
    k.trust(&env.known_hosts).unwrap();
    round_trip(&env.open(&ssh, Some("secret")).await.ok().unwrap()).await;

    // Another key recorded for the same host: refused, never offered for trust.
    let other = key("client", None).public_key().to_openssh().unwrap();
    std::fs::write(&env.known_hosts, format!("[127.0.0.1]:{} {other}\n", env.ssh_port)).unwrap();
    let msg = denied(env.open(&ssh, Some("secret")).await);
    assert!(msg.contains("has changed"), "{msg}");
}

#[tokio::test]
async fn password_authentication() {
    let env = env().await;
    let ssh = env.ssh(DbSshAuth::Password);
    let tunnel = env.open_trusted(&ssh, Some("secret")).await.ok().unwrap();
    round_trip(&tunnel).await;
    round_trip(&tunnel).await;
    assert!(!tunnel.is_closed());

    assert!(denied(env.open(&ssh, None).await).starts_with("SSH password required"));
    assert!(denied(env.open(&ssh, Some("wrong")).await).starts_with("SSH authentication failed"));
}

#[tokio::test]
async fn key_pair_authentication_with_and_without_passphrase() {
    let env = env().await;
    let ssh = DbSsh { key_file: fixture("client").to_string_lossy().into(), ..env.ssh(DbSshAuth::KeyPair) };
    round_trip(&env.open_trusted(&ssh, None).await.ok().unwrap()).await;

    // An encrypted key the server does not accept: passphrase first, then the key is refused.
    let locked = DbSsh { key_file: fixture("locked").to_string_lossy().into(), ..ssh.clone() };
    assert!(denied(env.open(&locked, None).await).starts_with("SSH key passphrase required"));
    assert!(denied(env.open(&locked, Some("nope")).await).contains("wrong passphrase"));
    assert!(denied(env.open(&locked, Some("pw")).await).starts_with("SSH authentication failed"));
}

#[tokio::test]
async fn unreachable_database_fails_fast_with_the_reason() {
    let env = env().await;
    let ssh = env.ssh(DbSshAuth::Password);
    drop(env.open_trusted(&ssh, Some("secret")).await.ok().unwrap());
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let r = Tunnel::open(TunnelSpec {
        ssh: &ssh,
        secret: Some("secret"),
        target_host: "127.0.0.1",
        target_port: closed,
        known_hosts: &env.known_hosts,
        ssh_config: None,
    })
    .await;
    let Err(OpenError::Other(e)) = r else { panic!("expected an error") };
    assert!(e.message.contains(&format!("cannot reach the database at 127.0.0.1:{closed}")), "{}", e.message);
}
