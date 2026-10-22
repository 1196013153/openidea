//! Local History beyond single files: folders, labels, restoring deleted files.

use crate::state::AppState;
use ide_core::IdeResult;
use ide_workspace::DirectoryHistory;
use std::path::PathBuf;
use tauri::{State, Window};

use super::doc::blocking;

/// Show History on a folder: snapshots of the files under it (deleted ones included) and labels.
#[tauri::command]
#[specta::specta]
pub async fn history_list_dir(
    window: Window,
    state: State<'_, AppState>,
    path: PathBuf,
) -> IdeResult<DirectoryHistory> {
    let project = state.project(window.label())?;
    blocking(move || project.history.list_dir(&path)).await
}

/// Local History › Put Label…: a named point in the history of every file.
#[tauri::command]
#[specta::specta]
pub fn history_put_label(window: Window, state: State<'_, AppState>, label: String) -> IdeResult<()> {
    let project = state.project(window.label())?;
    project.history.put_label(&project.root, &label)
}

/// Revert to a snapshot: writes its content to `path` (re-creating a deleted
/// file and its folders); an open editor updates in place.
#[tauri::command]
#[specta::specta]
pub async fn history_restore(window: Window, state: State<'_, AppState>, path: PathBuf, id: String) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || {
        let text = project.history.content(&id)?;
        if let Some(doc) = project.documents.by_path(&path) {
            project.documents.replace_all(doc, &text)?;
            return project.documents.save(doc);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if !path.exists() {
            ide_vfs::create_file(&path)?;
        }
        let doc = project.documents.open(&path)?.id;
        let result = project.documents.replace_all(doc, &text).and_then(|_| project.documents.save(doc));
        project.documents.close(doc);
        result
    })
    .await
}
