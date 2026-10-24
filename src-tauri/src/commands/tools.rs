//! Language server / debug adapter installer (`ide-tools`).

use crate::state::AppState;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_tools::{InstallEvent, ToolInfo, Tools};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Window};

/// The installer, reporting the executables chosen in the window's settings.
fn tools(app: &AppHandle, state: &AppState, window: &Window) -> IdeResult<Tools> {
    let data = app.path().app_data_dir().map_err(|e| IdeError::internal(e.to_string()))?;
    let (settings, root) = match state.project(window.label()) {
        Ok(project) => (project.settings.effective(), project.root.clone()),
        Err(_) => (state.global_settings.effective(), Default::default()),
    };
    let custom = settings
        .tools
        .iter()
        .filter_map(|(command, t)| Some((command.clone(), ide_sdk::apply::setting_path(&root, &t.path)?)))
        .collect();
    Ok(Tools::new(&data).with_custom_paths(custom))
}

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

/// Status of every known language server / debug adapter and the languages using it.
#[tauri::command]
#[specta::specta]
pub async fn tools_list(app: AppHandle, window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ToolInfo>> {
    let tools = tools(&app, &state, &window)?;
    let langs = state.languages.all();
    tauri::async_runtime::spawn_blocking(move || tools.list(&langs)).await.map_err(join_err)
}

/// Installs (or reinstalls) a tool into `<app-data>/tools`, streaming output through
/// `on_event`. Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn tools_install(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    name: String,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<ToolInfo> {
    let tools = tools(&app, &state, &window)?;
    let langs = state.languages.all();
    let cancel = state.begin_request(request);
    let result = tauri::async_runtime::spawn_blocking(move || {
        tools.install(&name, &langs, &cancel, &|e| {
            let _ = on_event.send(e);
        })
    })
    .await
    .map_err(join_err);
    state.end_request(request);
    let info = result??;
    // Language servers whose launch depends on installed tools (jdtls loads the
    // java-debug bundle) pick the change up.
    reconfigure_servers(&state);
    Ok(info)
}

/// Removes a tool the IDE installed.
#[tauri::command]
#[specta::specta]
pub async fn tools_uninstall(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    name: String,
) -> IdeResult<ToolInfo> {
    let tools = tools(&app, &state, &window)?;
    let langs = state.languages.all();
    let info =
        tauri::async_runtime::spawn_blocking(move || tools.uninstall(&name, &langs)).await.map_err(join_err)??;
    reconfigure_servers(&state);
    Ok(info)
}

fn reconfigure_servers(state: &AppState) {
    for project in state.projects() {
        let lsp = project.lsp.clone();
        tauri::async_runtime::spawn(async move { lsp.reconfigure().await });
    }
}
