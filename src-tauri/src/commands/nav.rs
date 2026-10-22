use crate::state::AppState;
use ide_core::IdeResult;
use ide_index::{FileMatch, IndexStatus, SymbolFilter, SymbolMatch};
use std::path::PathBuf;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub fn index_status(window: Window, state: State<'_, AppState>) -> IdeResult<IndexStatus> {
    Ok(state.project(window.label())?.index.status())
}

#[tauri::command]
#[specta::specta]
pub fn find_files(window: Window, state: State<'_, AppState>, query: String, limit: u32) -> IdeResult<Vec<FileMatch>> {
    Ok(state.project(window.label())?.index.find_files(&query, limit as usize))
}

#[tauri::command]
#[specta::specta]
pub fn find_symbols(
    window: Window,
    state: State<'_, AppState>,
    query: String,
    filter: SymbolFilter,
    limit: u32,
) -> IdeResult<Vec<SymbolMatch>> {
    Ok(state.project(window.label())?.index.find_symbols(&query, filter, limit as usize))
}

#[tauri::command]
#[specta::specta]
pub fn mark_recent(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    state.project(window.label())?.index.mark_recent(&path);
    Ok(())
}

/// Recently opened files, most recent first (⌘E).
#[tauri::command]
#[specta::specta]
pub fn recent_files(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ide_core::IpcPath>> {
    Ok(state.project(window.label())?.index.recent_files().into_iter().map(Into::into).collect())
}
