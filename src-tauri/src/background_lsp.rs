//! Language servers of project windows left in the background are stopped to free
//! their memory (a Java server holds about a gigabyte per project) and started again
//! when the window is used. A window counts as in the background while another
//! project window (or tab) is the one last used, not while the app is: switching to
//! a browser keeps the current project's servers running.

use crate::state::AppState;
use crate::windows::{WindowsState, project_window_labels, settings_parent};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const POLL: Duration = Duration::from_secs(30);

/// A project window (or its settings window) was focused: its servers run again.
pub fn on_focused(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<AppState>()
        && let Ok(project) = state.host.project(label)
    {
        project.lsp.resume();
    }
}

/// Watches which project window is in use and suspends the servers of the others
/// after Settings › System Settings › "Stop language servers of background windows after".
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("background-lsp".into())
        .spawn(move || {
            let mut since: HashMap<String, Instant> = HashMap::new();
            loop {
                std::thread::sleep(POLL);
                let (Some(state), Some(windows)) = (app.try_state::<AppState>(), app.try_state::<WindowsState>())
                else {
                    continue;
                };
                let minutes = state.global_settings.effective().general.stop_background_language_servers_minutes;
                let Some(current) = windows.last_focused() else { continue };
                let current = settings_parent(&current).unwrap_or(&current).to_owned();
                let labels = project_window_labels(&app);
                since.retain(|l, _| labels.contains(l));
                if minutes == 0 {
                    since.clear();
                    continue;
                }
                let limit = Duration::from_secs(u64::from(minutes) * 60);
                for label in labels {
                    if label == current {
                        since.remove(&label);
                        continue;
                    }
                    let background = *since.entry(label.clone()).or_insert_with(Instant::now);
                    if background.elapsed() < limit {
                        continue;
                    }
                    if let Ok(project) = state.host.project(&label)
                        && !project.lsp.is_suspended()
                    {
                        let lsp = project.lsp.clone();
                        tauri::async_runtime::spawn(async move { lsp.suspend().await });
                    }
                }
            }
        })
        .expect("spawn background-lsp thread");
}
