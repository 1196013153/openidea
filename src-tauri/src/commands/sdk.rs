//! Interpreters / toolchains (`ide-sdk`): discovery, Python virtualenvs and packages.

use crate::state::AppState;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_sdk::python::PythonPackage;
use ide_sdk::{Sdk, SdkKind};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{State, Window};

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

/// Installed interpreters / toolchains of `kind`; project-local ones first.
#[tauri::command]
#[specta::specta]
pub async fn sdk_detect(window: Window, state: State<'_, AppState>, kind: SdkKind) -> IdeResult<Vec<Sdk>> {
    let root = state.project(window.label()).ok().map(|p| p.root.clone());
    tauri::async_runtime::spawn_blocking(move || ide_sdk::detect(kind, root.as_deref())).await.map_err(join_err)
}

/// The interpreter the project uses: the configured one, else its virtualenv.
#[tauri::command]
#[specta::specta]
pub fn sdk_python_effective(window: Window, state: State<'_, AppState>) -> IdeResult<Option<ide_core::IpcPath>> {
    let project = state.project(window.label())?;
    Ok(ide_sdk::apply::python_interpreter(&project.root, &project.settings.effective()).map(Into::into))
}

/// Executables found for "run this file", and where single files are compiled to.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocatedTools {
    pub tools: Vec<ide_sdk::locate::LocatedTool>,
    pub compile_dir: ide_core::IpcPath,
}

/// Looks up `names` (bare command names): `node_modules/.bin` above `near`, then the search path.
#[tauri::command]
#[specta::specta]
pub async fn sdk_locate_tools(names: Vec<String>, near: Option<PathBuf>) -> IdeResult<LocatedTools> {
    tauri::async_runtime::spawn_blocking(move || LocatedTools {
        tools: ide_sdk::locate::locate_tools(&names, near.as_deref()),
        compile_dir: ide_sdk::locate::compile_dir().into(),
    })
    .await
    .map_err(join_err)
}

/// `base -m venv location`; output lines stream through `on_output`.
#[tauri::command]
#[specta::specta]
pub async fn sdk_python_create_venv(
    state: State<'_, AppState>,
    base: PathBuf,
    location: PathBuf,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<Sdk> {
    let cancel = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
        ide_sdk::python::create_venv(&base, &location, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
    .map_err(join_err);
    state.end_request(request);
    result?
}

#[tauri::command]
#[specta::specta]
pub async fn sdk_python_packages(
    state: State<'_, AppState>,
    python: PathBuf,
    request: RequestId,
) -> IdeResult<Vec<PythonPackage>> {
    let cancel = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || ide_sdk::python::list_packages(&python, &cancel))
        .await
        .map_err(join_err);
    state.end_request(request);
    result?
}

/// Installs (`uninstall = false`) or removes a package; output streams through `on_output`.
#[tauri::command]
#[specta::specta]
pub async fn sdk_python_pip(
    state: State<'_, AppState>,
    python: PathBuf,
    requirement: String,
    uninstall: bool,
    upgrade: bool,
    request: RequestId,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let cancel = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let send = |line: String| {
            let _ = on_output.send(line);
        };
        if uninstall {
            ide_sdk::python::uninstall_package(&python, &requirement, &cancel, &send)
        } else {
            ide_sdk::python::install_package(&python, &requirement, upgrade, &cancel, &send)
        }
    })
    .await
    .map_err(join_err);
    state.end_request(request);
    result?
}
