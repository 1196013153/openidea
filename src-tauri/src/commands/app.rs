use crate::state::AppState;
use ide_core::settings::Settings;
use ide_core::{EventSink, IdeError, IdeResult, RequestId};
use ide_language::LanguageInfo;
use ide_workspace::RecentProject;
use ide_workspace::settings::SettingsScope;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tauri::{Manager, State, Window};

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub config_dir: ide_core::IpcPath,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub root: ide_core::IpcPath,
    pub name: String,
    pub is_git: bool,
    pub settings: Settings,
}

#[tauri::command]
#[specta::specta]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    state.note_ipc();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        config_dir: state.config_dir.clone().into(),
    }
}

#[tauri::command]
#[specta::specta]
pub fn recent_projects(state: State<'_, AppState>) -> Vec<RecentProject> {
    state.note_ipc();
    state.recent.list()
}

#[tauri::command]
#[specta::specta]
pub fn remove_recent_project(state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    state.recent.remove(&path)
}

#[tauri::command]
#[specta::specta]
pub async fn open_project(window: Window, path: PathBuf) -> IdeResult<ProjectInfo> {
    // Opening touches the disk (index cache, watcher, git): keep it off the async runtime threads.
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    // Replacing this window's project (the UI skips reopening the same one).
    if app.state::<AppState>().project(&label).is_ok() {
        crate::windows::close_settings_window(&app, &label);
    }
    let project = tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().open_project(&label, &path))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    let info = project_info(&project);
    let _ = window.set_title(&info.name);
    Ok(info)
}

fn project_info(project: &crate::state::Project) -> ProjectInfo {
    ProjectInfo {
        name: project.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        is_git: !project.repos.read().is_empty(),
        settings: project.settings.effective(),
        root: project.root.clone().into(),
    }
}

#[tauri::command]
#[specta::specta]
pub fn close_project(window: Window, state: State<'_, AppState>) {
    crate::windows::close_settings_window(window.app_handle(), window.label());
    state.close_project(window.label());
}

#[tauri::command]
#[specta::specta]
pub fn languages(state: State<'_, AppState>) -> Vec<LanguageInfo> {
    state.note_ipc();
    let mut out: Vec<LanguageInfo> = state.languages.all().iter().map(LanguageInfo::from).collect();
    // Plugin-contributed languages; built-in definitions win on id clashes.
    for lang in state.plugins.languages() {
        if !out.iter().any(|l| l.id == lang.id) {
            out.push(LanguageInfo::from(&lang));
        }
    }
    out
}

/// Effective settings for the window's project, or global settings without one.
#[tauri::command]
#[specta::specta]
pub fn settings_get(window: Window, state: State<'_, AppState>) -> Settings {
    state.note_ipc();
    match state.project(window.label()) {
        Ok(p) => p.settings.effective(),
        Err(_) => state.global_settings.effective(),
    }
}

/// `value` is JSON text, e.g. `14` or `"dark"`. Every window (for a project
/// value: that project's windows) is told (`IdeEvent::SettingsChanged`) so it
/// re-reads its effective settings.
#[tauri::command]
#[specta::specta]
pub fn settings_set(
    window: Window,
    state: State<'_, AppState>,
    scope: SettingsScope,
    key: String,
    value: String,
) -> IdeResult<Settings> {
    let value: serde_json::Value =
        serde_json::from_str(&value).map_err(|e| ide_core::IdeError::invalid(e.to_string()))?;
    let current = state.project(window.label()).ok();
    let project_scope = matches!(scope, SettingsScope::Project) && current.is_some();
    let settings = match &current {
        Some(p) if project_scope => p.settings.set(scope, &key, value)?,
        Some(p) => {
            state.global_settings.set(SettingsScope::Global, &key, value)?;
            p.settings.reload()
        }
        None => state.global_settings.set(SettingsScope::Global, &key, value)?,
    };
    if let Some(p) = &current {
        p.documents.set_file_defaults(ide_workspace::FileDefaults::from_settings(&settings, Some(&p.root)));
    }
    // A global value reaches every other open project too.
    if !project_scope {
        for project in state.projects() {
            if current.as_ref().is_some_and(|c| c.root == project.root) {
                continue;
            }
            let effective = project.settings.reload();
            project
                .documents
                .set_file_defaults(ide_workspace::FileDefaults::from_settings(&effective, Some(&project.root)));
        }
    }
    // A new interpreter / toolchain / server executable restarts the language servers it affects.
    if ["languages", "tools"].iter().any(|k| key == *k || key.starts_with(&format!("{k}."))) {
        let affected = if project_scope { current.iter().cloned().collect() } else { state.projects() };
        for project in affected {
            let lsp = project.lsp.clone();
            tauri::async_runtime::spawn(async move { lsp.reconfigure().await });
        }
    }
    let roots_changed = key == "projectStructure" || key.starts_with("projectStructure.");
    // A project value concerns only that project's window (and its settings window).
    let event = ide_core::IdeEvent::SettingsChanged { key };
    if project_scope {
        let owner = AppState::owner_window(window.label());
        for label in [owner.to_owned(), crate::windows::settings_label(owner)] {
            let sink = crate::events::TauriSink { app: state.app.clone(), window: Some(label) };
            sink.emit(event.clone());
            if let Some(p) = current.as_ref().filter(|_| roots_changed) {
                sink.emit(ide_core::IdeEvent::ProjectRootsChanged { root: p.root.clone().into() });
            }
        }
    } else {
        state.sink.emit(event);
    }
    Ok(settings)
}

/// Effective source / test / resource / excluded roots of the window's project:
/// auto-detected from build files, overridden by Settings › Project Structure.
#[tauri::command]
#[specta::specta]
pub fn project_roots(window: Window, state: State<'_, AppState>) -> IdeResult<ide_workspace::ProjectRoots> {
    Ok(state.project(window.label())?.roots())
}

/// The project open in this window (a settings window: its parent's), if any.
#[tauri::command]
#[specta::specta]
pub fn project_current(window: Window, state: State<'_, AppState>) -> Option<ProjectInfo> {
    state.project(window.label()).ok().map(|p| project_info(&p))
}

#[tauri::command]
#[specta::specta]
pub fn cancel_request(state: State<'_, AppState>, id: RequestId) {
    state.cancel_request(id);
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// Routes frontend logs into the backend `tracing` pipeline.
#[tauri::command]
#[specta::specta]
pub fn log_frontend(level: LogLevel, message: String) {
    match level {
        LogLevel::Debug => tracing::debug!(target: "frontend", "{message}"),
        LogLevel::Info => tracing::info!(target: "frontend", "{message}"),
        LogLevel::Warn => tracing::warn!(target: "frontend", "{message}"),
        LogLevel::Error => tracing::error!(target: "frontend", "{message}"),
    }
}
