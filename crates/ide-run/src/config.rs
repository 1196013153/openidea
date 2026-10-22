//! User-defined run configurations persisted in `<root>/.openidea/run.toml`:
//!
//! ```toml
//! [[configurations]]
//! id = "user:server"
//! name = "Server"
//! kind = "shell"
//! command = "cargo"
//! args = ["run", "--release"]
//! cwd = "server"
//! env = { RUST_LOG = "debug" }
//! is-test = false
//! debug-adapter = "codelldb"
//! ```

use crate::RunConfig;
use ide_core::{IdeError, IdeResult, project_dir};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use toml_edit::{Array, ArrayOfTables, DocumentMut, InlineTable, Item, Table, value};

const FILE: &str = "run.toml";

/// Where run configurations are written.
pub(crate) fn config_path(root: &Path) -> PathBuf {
    project_dir::path(root, FILE)
}

#[derive(Deserialize)]
struct FileDoc {
    #[serde(default)]
    configurations: Vec<FileConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct FileConfig {
    id: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<PathBuf>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default, alias = "isTest", alias = "is_test")]
    is_test: bool,
    #[serde(alias = "debugAdapter", alias = "debug_adapter")]
    debug_adapter: Option<String>,
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

pub(crate) fn load(root: &Path) -> IdeResult<Vec<RunConfig>> {
    let path = config_path(root);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let doc: FileDoc =
        toml::from_str(&text).map_err(|e| IdeError::invalid(format!("{}: {}", path.display(), e.message())))?;
    let mut out = Vec::with_capacity(doc.configurations.len());
    for (i, c) in doc.configurations.into_iter().enumerate() {
        let name = c.name.filter(|n| !n.is_empty()).unwrap_or_else(|| {
            if c.command.is_empty() { format!("Configuration {}", i + 1) } else { c.command.clone() }
        });
        let id = c.id.filter(|id| !id.is_empty()).unwrap_or_else(|| format!("user:{}", slug(&name)));
        out.push(RunConfig {
            id,
            name,
            kind: c.kind.filter(|k| !k.is_empty()).unwrap_or_else(|| "shell".to_owned()),
            command: c.command,
            args: c.args,
            cwd: c.cwd.filter(|p| !p.as_os_str().is_empty()).map(Into::into),
            env: c.env,
            detected: false,
            is_test: c.is_test,
            debug_adapter: c.debug_adapter.filter(|d| !d.is_empty()),
        });
    }
    Ok(out)
}

fn to_table(c: &RunConfig) -> Table {
    let mut t = Table::new();
    t.insert("id", value(&c.id));
    t.insert("name", value(&c.name));
    t.insert("kind", value(&c.kind));
    t.insert("command", value(&c.command));
    if !c.args.is_empty() {
        t.insert("args", value(c.args.iter().collect::<Array>()));
    }
    if let Some(cwd) = &c.cwd {
        t.insert("cwd", value(cwd.to_string_lossy().replace('\\', "/")));
    }
    if !c.env.is_empty() {
        let mut env = InlineTable::new();
        for (k, v) in &c.env {
            env.insert(k, v.into());
        }
        t.insert("env", value(env));
    }
    if c.is_test {
        t.insert("is-test", value(true));
    }
    if let Some(adapter) = &c.debug_adapter {
        t.insert("debug-adapter", value(adapter));
    }
    t
}

pub(crate) fn save(root: &Path, configs: &[RunConfig]) -> IdeResult<()> {
    let path = config_path(root);
    let existing = match fs::read_to_string(&path) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if existing.is_none() && configs.is_empty() {
        return Ok(());
    }
    // Keep unrelated keys and comments; a file we cannot parse is replaced.
    let mut doc = existing.as_deref().and_then(|t| t.parse::<DocumentMut>().ok()).unwrap_or_default();
    let mut array = ArrayOfTables::new();
    for c in configs {
        array.push(to_table(c));
    }
    if configs.is_empty() {
        doc.remove("configurations");
    } else {
        doc.insert("configurations", Item::ArrayOfTables(array));
    }

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, doc.to_string())?;
    fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(())
}
