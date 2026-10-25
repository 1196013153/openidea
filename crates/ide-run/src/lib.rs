//! Run configurations and process management.

mod config;
mod detect;
pub mod junit;
mod process;
mod utf8;
pub mod which;
pub mod wrap;

pub use process::{ProcessManager, StartOptions};

use ide_core::{IdeResult, RunId};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunConfig {
    /// Stable id, e.g. `npm:dev`, `cargo:run:app`, or a uuid for user-defined.
    pub id: String,
    pub name: String,
    /// `npm` | `cargo` | `gradle` | `maven` | `go` | `python` | `pytest` | `make` | `shell` …
    pub kind: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<ide_core::IpcPath>,
    pub env: BTreeMap<String, String>,
    /// Detected configs are regenerated; user configs persist in `.openidea/run.toml`.
    pub detected: bool,
    /// Test runner configs render results in the test tree.
    pub is_test: bool,
    /// DAP adapter that can debug this config, if any.
    pub debug_adapter: Option<String>,
    /// "Allow multiple instances": Run on a running config starts another one instead of restarting it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[specta(optional)]
    pub allow_parallel: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutputChunk {
    Stdout {
        text: String,
    },
    Stderr {
        text: String,
    },
    /// System message from the IDE (command line echo, exit code).
    System {
        text: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub id: RunId,
    pub config_id: String,
    pub name: String,
    pub pid: Option<u32>,
    pub running: bool,
}

/// Detects configs from package.json scripts, Cargo.toml targets, build.gradle(.kts),
/// pom.xml, go.mod, pyproject/pytest, Makefile.
pub fn detect(root: &Path) -> Vec<RunConfig> {
    detect::detect(root)
}

/// Reads `<root>/.openidea/run.toml`; a missing file yields no configs.
pub fn load_user_configs(root: &Path) -> IdeResult<Vec<RunConfig>> {
    config::load(root)
}

/// Writes `<root>/.openidea/run.toml`, preserving unrelated content in the file.
pub fn save_user_configs(root: &Path, configs: &[RunConfig]) -> IdeResult<()> {
    config::save(root, configs)
}

/// Path of the user run configuration file for `root`.
pub fn user_configs_path(root: &Path) -> PathBuf {
    config::config_path(root)
}
