//! Data sources: per-project connection settings in `.openidea/data-sources.toml`.
//! Passwords never go there: saved ones live in [`crate::secrets`], the others
//! only in memory for the session.

use ide_core::{IdeError, IdeResult, IpcPath, project_dir};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

const FILE: &str = "data-sources.toml";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbDriver {
    Sqlite,
    Postgres,
    /// MySQL and MariaDB.
    Mysql,
}

impl DbDriver {
    pub fn default_port(self) -> Option<u16> {
        match self {
            DbDriver::Sqlite => None,
            DbDriver::Postgres => Some(5432),
            DbDriver::Mysql => Some(3306),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbSslMode {
    Disable,
    #[default]
    Prefer,
    Require,
}

/// How the SSH tunnel authenticates (IDEA's SSH configuration "Authentication type").
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbSshAuth {
    Password,
    /// A private key file, optionally protected by a passphrase.
    KeyPair,
    /// `~/.ssh/config` (HostName, User, Port, IdentityFile, ProxyJump) and the SSH agent.
    #[default]
    OpenSsh,
}

/// Connect through an SSH tunnel: the database host and port are reached from `host`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct DbSsh {
    pub enabled: bool,
    /// Host name, or a `Host` alias of `~/.ssh/config` with [`DbSshAuth::OpenSsh`].
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    pub auth: DbSshAuth,
    /// Private key for [`DbSshAuth::KeyPair`]; `~/` is the home directory.
    pub key_file: String,
    /// Keep the SSH password / key passphrase in the saved passwords.
    pub save_secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct DataSource {
    pub id: String,
    pub name: String,
    pub driver: DbDriver,
    pub host: String,
    pub port: Option<u16>,
    pub database: String,
    pub user: String,
    /// SQLite database file (absolute, or relative to the project root).
    pub file: Option<IpcPath>,
    pub ssl: DbSslMode,
    /// Keep the password in the saved passwords.
    pub save_password: bool,
    /// Refuse statements other than queries (enforced by the database session where possible).
    pub read_only: bool,
    /// SSH tunnel settings (`None`: never configured; kept but unused when not `enabled`).
    pub ssh: Option<DbSsh>,
}

impl Default for DataSource {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            driver: DbDriver::Sqlite,
            host: "localhost".into(),
            port: None,
            database: String::new(),
            user: String::new(),
            file: None,
            ssl: DbSslMode::Prefer,
            save_password: false,
            read_only: false,
            ssh: None,
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SourcesFile {
    #[serde(default, rename = "data-source")]
    sources: Vec<DataSource>,
}

pub fn load(root: &Path) -> IdeResult<Vec<DataSource>> {
    let path = project_dir::path(root, FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let file: SourcesFile = toml::from_str(&text).map_err(|e| IdeError::invalid(format!("{}: {e}", path.display())))?;
    Ok(file.sources)
}

pub fn save(root: &Path, sources: &[DataSource]) -> IdeResult<()> {
    for s in sources {
        if s.id.is_empty() || s.name.trim().is_empty() {
            return Err(IdeError::invalid("every data source needs an id and a name"));
        }
    }
    let path = project_dir::path(root, FILE);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = toml::to_string_pretty(&SourcesFile { sources: sources.to_vec() })
        .map_err(|e| IdeError::internal(e.to_string()))?;
    std::fs::write(path, text)?;
    Ok(())
}

/// Credential store access. Blocking (may show an OS prompt): call off the async runtime.
/// Keys are data source ids; [`secrets::ssh_key`] names the SSH password / passphrase.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_without_passwords() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(load(tmp.path()).unwrap().is_empty());
        let s = DataSource {
            id: "a1".into(),
            name: "local".into(),
            driver: DbDriver::Postgres,
            port: Some(5433),
            database: "app".into(),
            user: "me".into(),
            save_password: true,
            ..Default::default()
        };
        save(tmp.path(), std::slice::from_ref(&s)).unwrap();
        let text = std::fs::read_to_string(tmp.path().join(".openidea/data-sources.toml")).unwrap();
        assert!(!text.contains("password ="), "{text}");
        assert_eq!(load(tmp.path()).unwrap(), vec![s]);
        assert!(save(tmp.path(), &[DataSource::default()]).is_err());
    }
}
